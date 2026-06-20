/**
 * Transaction-level data for the portal "Ask AI" feature.
 *
 * The chat used to see only category TOTALS (P&L snapshots), so it couldn't
 * answer "how much did we pay Brandon in subcontractor fees this year?". This
 * pulls the client's actual transactions from QBO's TransactionList report
 * (all accounts, no filter) and returns:
 *   - `payeeSpend`: a COMPLETE per-payee rollup of expense transactions for the
 *     period (total paid + count). Answers vendor/payee questions exactly even
 *     when the individual rows are beyond the row cap.
 *   - `recent`: the most-recent N individual transactions (date, type, payee,
 *     account, amount, memo) so the model can cite line-level detail.
 *
 * Kept bounded so it fits the chat's input-token budget: the rollup is the
 * source of truth for totals; the raw list is a recent sample.
 */
import { qboRequest } from "./qbo";

export interface AiTransaction {
  date: string;
  type: string;
  num: string | null;
  payee: string;
  account: string;
  amount: number;
  memo: string;
}

export interface AiPayeeSpend {
  payee: string;
  totalPaid: number;
  txns: number;
}

export interface AiTransactionData {
  /** Total transactions in the period before the recent-sample cap. */
  totalCount: number;
  /** True when `recent` is a truncated sample of a larger set. */
  capped: boolean;
  /** Complete expense rollup by payee (top payees), total paid + count. */
  payeeSpend: AiPayeeSpend[];
  /** Most-recent individual transactions (sample). */
  recent: AiTransaction[];
}

// QBO TransactionList txn_type values that represent money PAID OUT and book a
// P&L expense directly (so summing them gives spend-per-payee without
// double-counting a Bill against its later Bill Payment, which settles A/P).
const EXPENSE_TYPE = /^(bill|check|cheque|expense|cash expense|credit card (expense|charge|purchase))$/i;

function num(v: any): number {
  const n = parseFloat(
    String(v ?? "")
      .replace(/[,$\s]/g, "")
      .replace(/^\((.+)\)$/, "-$1")
  );
  return isNaN(n) ? 0 : n;
}

export async function fetchAiTransactions(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string,
  opts?: { maxRecent?: number; maxPayees?: number }
): Promise<AiTransactionData> {
  const maxRecent = opts?.maxRecent ?? 400;
  const maxPayees = opts?.maxPayees ?? 120;
  const empty: AiTransactionData = { totalCount: 0, capped: false, payeeSpend: [], recent: [] };

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    columns: ["tx_date", "txn_type", "doc_num", "name", "memo", "account_name", "subt_nat_amount"].join(","),
    minorversion: "70",
  });

  let data: any;
  try {
    data = await qboRequest(realmId, accessToken, `/reports/TransactionList?${params.toString()}`);
  } catch {
    return empty;
  }

  // Map columns by ColType so we don't depend on order/localized titles.
  const cols: any[] = data?.Columns?.Column || [];
  const colType = cols.map((c: any) => String(c?.ColType || "").toLowerCase());
  const col = (...keys: string[]) => {
    for (const k of keys) {
      const i = colType.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iDate = col("tx_date");
  const iType = col("txn_type");
  const iNum = col("doc_num");
  const iName = col("name");
  const iMemo = col("memo");
  const iAcct = col("account_name");
  const iAmt = col("subt_nat_amount", "amount");

  const all: AiTransaction[] = [];
  const walk = (rows: any[]) => {
    for (const r of rows || []) {
      if (r?.type === "Data" && Array.isArray(r.ColData)) {
        const cd = r.ColData;
        const get = (i: number) => (i >= 0 ? String(cd[i]?.value ?? "") : "");
        const date = get(iDate);
        const payee = get(iName).trim();
        const amount = num(get(iAmt));
        if (!date && !payee && amount === 0) continue; // skip blanks/subtotals
        all.push({
          date,
          type: get(iType),
          num: get(iNum) || null,
          payee: payee || "(unnamed)",
          account: get(iAcct),
          amount,
          memo: get(iMemo),
        });
      }
      if (r?.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(data?.Rows?.Row || []);

  if (all.length === 0) return empty;

  // Complete per-payee spend rollup — expense transactions only.
  const rollup = new Map<string, AiPayeeSpend>();
  for (const t of all) {
    if (!EXPENSE_TYPE.test(t.type)) continue;
    if (!t.payee || t.payee === "(unnamed)") continue;
    const key = t.payee.toLowerCase();
    const g = rollup.get(key) || { payee: t.payee, totalPaid: 0, txns: 0 };
    g.totalPaid += Math.abs(t.amount);
    g.txns += 1;
    rollup.set(key, g);
  }
  const payeeSpend = [...rollup.values()]
    .map((p) => ({ payee: p.payee, totalPaid: Math.round(p.totalPaid), txns: p.txns }))
    .sort((a, b) => b.totalPaid - a.totalPaid)
    .slice(0, maxPayees);

  // Recent individual transactions (newest first), capped.
  const sorted = [...all].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const recent = sorted.slice(0, maxRecent).map((t) => ({ ...t, amount: Math.round(t.amount) }));

  return {
    totalCount: all.length,
    capped: all.length > maxRecent,
    payeeSpend,
    recent,
  };
}
