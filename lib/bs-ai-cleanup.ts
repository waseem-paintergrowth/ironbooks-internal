/**
 * AI-assisted Balance Sheet cleanup.
 * ===================================
 *
 * Three-stage flow:
 *   1. Snapshot — pull every BS account + recent transactions on suspect ones
 *   2. Analyze  — Claude reviews the snapshot, returns structured Issues
 *   3. Finalize — bookkeeper-approved fixes execute against QBO
 *
 * This file owns stages 1 + 2. Finalize lives in the route handler so it
 * can call the existing reclassifyTransactionLines + new createJournalEntry
 * helpers with proper auth + audit logging.
 */

import Anthropic from "@anthropic-ai/sdk";
import { fetchAllAccounts } from "./qbo";
import { fetchTransactionsForAccount, type ReclassLine } from "./qbo-reclass";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

// ─── TYPES ─────────────────────────────────────────────────────────────

export type IssueKind =
  | "undeposited_funds_clearing"
  | "suspense_reclass"
  | "obe_to_retained_earnings"
  | "stale_uncleared_bank_line"
  | "ar_aging_writeoff"
  | "ap_aging_writeoff"
  | "negative_balance"
  | "inter_account_transfer_dupe"
  | "other";

export type FixType = "reclass_lines" | "journal_entry" | "flag_for_manual";

export interface ReclassLineFix {
  type: "reclass_lines";
  lines: Array<{
    qbo_transaction_id: string;
    qbo_transaction_type: string;
    qbo_line_id: string;
    sync_token?: string;
    new_account_id: string;
    new_account_name: string;
    amount: number;
  }>;
}

export interface JournalEntryFix {
  type: "journal_entry";
  je: {
    txn_date: string;
    doc_number?: string;
    private_note: string;
    lines: Array<{
      posting_type: "Debit" | "Credit";
      amount: number;
      account_id: string;
      account_name: string;
      description: string;
    }>;
  };
}

export interface FlagFix {
  type: "flag_for_manual";
  notes: string;
}

export type ProposedFix = ReclassLineFix | JournalEntryFix | FlagFix;

export interface Issue {
  kind: IssueKind;
  account_qbo_id: string | null;
  account_name: string | null;
  description: string;
  ai_reasoning: string;
  confidence: number;
  risk: "low" | "medium" | "high";
  estimated_impact: number;
  proposed_fix: ProposedFix;
}

export interface AnalysisResult {
  issues: Issue[];
  summary: string;
  warnings: string[];
}

// ─── SNAPSHOT ──────────────────────────────────────────────────────────

interface BsSnapshotAccount {
  id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  current_balance: number;
  active: boolean;
  parent_name: string | null;
}

interface PnlTarget {
  id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
}

interface BsSnapshot {
  client_name: string;
  jurisdiction: string;
  state_province: string;
  bs_accounts: BsSnapshotAccount[];
  /** P&L expense + income + COGS accounts. Claude needs these as valid
   *  target_account_id values for suspense_reclass fixes (moving items
   *  out of "Ask My Accountant" into "Paint & Materials" etc). Without
   *  this list, Claude either invents IDs or returns empty lines. */
  categorization_targets: PnlTarget[];
  retained_earnings_account: { id: string; name: string } | null;
  bad_debt_account: { id: string; name: string } | null;
  suspect_transactions: Record<string, ReclassLine[]>; // account_id → recent lines
}

/**
 * Pull a focused snapshot of the client's BS suitable for Claude analysis.
 * We pre-filter to "suspect" accounts (UF, OBE, Suspense, A/R, A/P, banks
 * with stale items) so the prompt isn't bloated with unremarkable rows.
 */
export async function buildBsSnapshot(params: {
  clientName: string;
  jurisdiction: string;
  stateProvince: string;
  realmId: string;
  accessToken: string;
  /** How many days back to scan for suspect transactions. Default 180. */
  lookbackDays?: number;
}): Promise<BsSnapshot> {
  const lookbackDays = params.lookbackDays ?? 180;

  const allAccounts = await fetchAllAccounts(params.realmId, params.accessToken);

  // Identify BS-typed accounts
  const BS_TYPES = new Set([
    "Bank",
    "Accounts Receivable",
    "Other Current Asset",
    "Fixed Asset",
    "Other Asset",
    "Accounts Payable",
    "Credit Card",
    "Other Current Liability",
    "Long Term Liability",
    "Equity",
  ]);
  const bsRaw = allAccounts.filter((a) => BS_TYPES.has(a.AccountType) && a.Active !== false);

  const bsAccounts: BsSnapshotAccount[] = bsRaw.map((a) => ({
    id: a.Id,
    name: a.Name,
    account_type: a.AccountType,
    account_subtype: a.AccountSubType || null,
    current_balance: Number(a.CurrentBalance || 0),
    active: a.Active !== false,
    parent_name: a.ParentRef?.name || null,
  }));

  // Find common target accounts that Claude will reference in fixes
  const retainedEarnings =
    allAccounts.find(
      (a) => a.AccountSubType === "RetainedEarnings" && a.Active !== false
    ) ||
    allAccounts.find(
      (a) =>
        a.AccountType === "Equity" &&
        /retained earnings/i.test(a.Name) &&
        a.Active !== false
    );
  const badDebt = allAccounts.find(
    (a) => /bad debt/i.test(a.Name) && a.Active !== false
  );

  // Identify suspect accounts that we want recent transactions for.
  // Keep this narrow so we don't burn tokens on unremarkable accounts.
  const SUSPECT_NAME_PATTERNS = [
    /undeposited/i,
    /opening balance equity/i,
    /\bobe\b/i,
    /ask my accountant/i,
    /suspense/i,
    /uncategorized/i,
  ];
  const suspectAccountIds = new Set<string>();
  for (const a of bsRaw) {
    if (SUSPECT_NAME_PATTERNS.some((re) => re.test(a.Name))) {
      suspectAccountIds.add(a.Id);
    }
    // Also pull AR + AP — aging analysis happens on these
    if (
      a.AccountType === "Accounts Receivable" ||
      a.AccountType === "Accounts Payable"
    ) {
      suspectAccountIds.add(a.Id);
    }
    // Banks + credit cards — we want stale uncleared lines
    if (a.AccountType === "Bank" || a.AccountType === "Credit Card") {
      suspectAccountIds.add(a.Id);
    }
    // Anything with negative balance on an asset, or positive on a liability,
    // that's suspicious enough to load lines for
    const bal = Number(a.CurrentBalance || 0);
    if (
      (a.Classification === "Asset" && bal < 0) ||
      (a.Classification === "Liability" && bal > 0 && a.AccountType !== "Accounts Payable" && a.AccountType !== "Credit Card" && a.AccountType !== "Other Current Liability" && a.AccountType !== "Long Term Liability")
    ) {
      suspectAccountIds.add(a.Id);
    }
  }

  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86_400_000);
  const startYmd = start.toISOString().slice(0, 10);
  const endYmd = end.toISOString().slice(0, 10);

  // Fetch lines for each suspect account sequentially (small N typically).
  // If this grows we can parallelize, but most clients have 3-8 suspect accounts.
  const suspectTransactions: Record<string, ReclassLine[]> = {};
  for (const accountId of suspectAccountIds) {
    try {
      const { lines } = await fetchTransactionsForAccount(
        params.realmId,
        params.accessToken,
        accountId,
        startYmd,
        endYmd
      );
      // Cap to most-recent 50 per account to keep prompt size reasonable
      const sorted = lines
        .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date))
        .slice(0, 50);
      if (sorted.length > 0) suspectTransactions[accountId] = sorted;
    } catch (err: any) {
      console.warn(
        `[bs-ai-cleanup] could not fetch lines for ${accountId}:`,
        err?.message
      );
    }
  }

  // P&L accounts — needed as valid targets for suspense_reclass.
  // Without these in the snapshot, Claude either hallucinates account
  // IDs or returns empty proposed_fix.lines arrays.
  const PNL_TYPES = new Set([
    "Income",
    "Other Income",
    "Expense",
    "Other Expense",
    "Cost of Goods Sold",
  ]);
  const categorizationTargets: PnlTarget[] = allAccounts
    .filter((a) => a.Active !== false && PNL_TYPES.has(a.AccountType))
    .map((a) => ({
      id: a.Id,
      name: a.Name,
      account_type: a.AccountType,
      account_subtype: a.AccountSubType || null,
    }));

  return {
    client_name: params.clientName,
    jurisdiction: params.jurisdiction,
    state_province: params.stateProvince,
    bs_accounts: bsAccounts,
    categorization_targets: categorizationTargets,
    retained_earnings_account: retainedEarnings
      ? { id: retainedEarnings.Id, name: retainedEarnings.Name }
      : null,
    bad_debt_account: badDebt ? { id: badDebt.Id, name: badDebt.Name } : null,
    suspect_transactions: suspectTransactions,
  };
}

// ─── ANALYSIS ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Ironbooks AI Bookkeeper performing a Balance Sheet cleanup review for a residential painting contractor.

You'll get a snapshot of every Balance Sheet account on the client's QBO COA plus recent transactions on the "suspect" accounts (Undeposited Funds, Opening Balance Equity, Suspense, A/R, A/P, banks, credit cards, accounts with impossible balances).

Your job: identify cleanup issues and propose specific, executable fixes.

═══ ISSUE TYPES TO LOOK FOR ═══

1. **undeposited_funds_clearing** — Undeposited Funds has a balance.
   Each line represents a customer payment received but not yet deposited.
   Real-world: bookkeeper forgot to record the bank deposit.
   Fix: a JE that debits the bank, credits Undeposited Funds — IF you can identify which bank account.
   Otherwise flag_for_manual and ask the bookkeeper to find the corresponding deposit.

2. **obe_to_retained_earnings** — Opening Balance Equity has a non-zero balance.
   This is a plug from QBO migration. It should be zero or moved to Retained Earnings.
   Fix: a JE moving the full balance to Retained Earnings.
   Only propose if you can see the Retained Earnings account in the snapshot.

3. **suspense_reclass** — "Ask My Accountant", "Suspense", or "Uncategorized" accounts have a balance.
   Each line is a misclassified transaction. Use the vendor + description to suggest the right account.
   Fix: reclass_lines, one entry per line with the correct target_account_id.
   Use the painter vendor knowledge in the system prompt:
     - Sherwin-Williams / Benjamin Moore / paint suppliers → Paint & Materials
     - Home Depot / Lowes → Job Supplies
     - Esso / Shell / gas stations → Fuel
     - Insurance vendors → General Liability Insurance
     - Etc.

4. **stale_uncleared_bank_line** — Bank lines >60 days old that haven't cleared.
   Could be: cheque never cashed, deposit that bounced, duplicate entry.
   For each stale line: flag_for_manual with notes recommending void/delete/reclass.

5. **ar_aging_writeoff** — A/R balances on customers >120 days old.
   Likely uncollectible. Propose JE: debit Bad Debt Expense, credit A/R.
   If no Bad Debt account exists, flag_for_manual.

6. **ap_aging_writeoff** — A/P balances on vendor credits >120 days old.
   Likely a stale credit or duplicate. Propose JE: debit A/P, credit Other Income (forgiven debt).
   Conservative: prefer flag_for_manual unless very confident.

7. **negative_balance** — Asset account with negative balance, or liability with
   wrong-sign balance. Root cause: usually a missing entry or duplicate.
   Flag_for_manual with the suspected cause.

═══ DECISION RULES ═══

- Only propose fixes when you have enough information. Otherwise return flag_for_manual.
- Confidence scoring: 0.95+ ONLY when the fix is unambiguous (e.g., OBE balance with RE account known). 0.7-0.94 when likely but with reasonable alternatives. <0.7 when significant doubt.
- Risk levels: low (small $, well-understood pattern), medium (medium $ or some ambiguity), high (tax-sensitive, large $, equity touches).
- ALL fixes that touch Equity, Payroll, Tax, or Owner Draw accounts → risk=high regardless of confidence.
- Reclass lines: use the exact qbo_transaction_id, qbo_line_id, and qbo_transaction_type from the snapshot. Don't invent them.
- Reclass lines: new_account_id MUST be one of the IDs from either bs_accounts or categorization_targets in the input. Never invent IDs.
- Journal entries: must balance (debits = credits). Use proper double-entry — assets+expenses on the debit side typically, liabilities+revenue+equity on the credit side.
- Journal entries: every line's account_id MUST exist in bs_accounts or categorization_targets. Round amounts to 2 decimals.
- CRITICAL: if a proposed_fix.lines or proposed_fix.je.lines array would be empty, return flag_for_manual instead. An empty fix is worse than no fix because it appears "executed" while doing nothing.
- For suspense_reclass: look up the matching target_account in categorization_targets by vendor pattern. If no obvious match exists, use flag_for_manual rather than guessing.

═══ EXAMPLES ═══

Example 1 — OBE has $2,300 plug from migration, RE account exists:
{
  "kind": "obe_to_retained_earnings",
  "account_qbo_id": "<OBE id>",
  "account_name": "Opening Balance Equity",
  "description": "Opening Balance Equity has a $2,300 plug from migration that should zero out.",
  "ai_reasoning": "OBE should be 0 once a company is past its first year. This balance is almost certainly a data-migration plug. Moving to Retained Earnings is the standard fix.",
  "confidence": 0.97,
  "risk": "medium",
  "estimated_impact": 2300,
  "proposed_fix": {
    "type": "journal_entry",
    "je": {
      "txn_date": "2026-05-21",
      "private_note": "Zero out OBE migration plug",
      "lines": [
        { "posting_type": "Debit",  "amount": 2300.00, "account_id": "<OBE id>", "account_name": "Opening Balance Equity", "description": "Clear OBE" },
        { "posting_type": "Credit", "amount": 2300.00, "account_id": "<RE id>",  "account_name": "Retained Earnings",       "description": "Reclassify from OBE" }
      ]
    }
  }
}

Example 2 — Ask My Accountant has a $450 Sherwin-Williams charge:
{
  "kind": "suspense_reclass",
  "account_qbo_id": "<AMA id>",
  "account_name": "Ask My Accountant",
  "description": "$450 Sherwin-Williams charge sitting in Ask My Accountant.",
  "ai_reasoning": "Sherwin-Williams is a paint supplier — belongs in Paint & Materials, not the suspense account.",
  "confidence": 0.96,
  "risk": "low",
  "estimated_impact": 450,
  "proposed_fix": {
    "type": "reclass_lines",
    "lines": [
      {
        "qbo_transaction_id": "1234",
        "qbo_transaction_type": "Expense",
        "qbo_line_id": "1",
        "new_account_id": "<Paint & Materials id from categorization_targets>",
        "new_account_name": "Paint & Materials",
        "amount": 450.00
      }
    ]
  }
}

Example 3 — Mystery $1,200 in Suspense, no clear vendor pattern:
{
  "kind": "suspense_reclass",
  "account_qbo_id": "<Suspense id>",
  "account_name": "Suspense",
  "description": "$1,200 entry from 'PAYMENT THANK YOU' with no other context.",
  "ai_reasoning": "No vendor name, no memo, no recognizable pattern. Bookkeeper needs to investigate the source document before reclassifying.",
  "confidence": 0.4,
  "risk": "medium",
  "estimated_impact": 1200,
  "proposed_fix": {
    "type": "flag_for_manual",
    "notes": "Pull the source transaction's original document to identify what this payment was for. Likely a credit card payment or owner contribution but unclear."
  }
}

═══ OUTPUT ═══

Return STRICTLY valid JSON. No markdown, no preamble.

{
  "summary": "1-2 sentences on overall BS health",
  "warnings": ["string", ...],
  "issues": [
    {
      "kind": "undeposited_funds_clearing" | "obe_to_retained_earnings" | "suspense_reclass" | "stale_uncleared_bank_line" | "ar_aging_writeoff" | "ap_aging_writeoff" | "negative_balance" | "other",
      "account_qbo_id": "string or null",
      "account_name": "string or null",
      "description": "human-readable problem, 1 sentence",
      "ai_reasoning": "why this is the right fix, 1-2 sentences",
      "confidence": 0.0-1.0,
      "risk": "low" | "medium" | "high",
      "estimated_impact": number (dollar amount, positive),
      "proposed_fix": {
        "type": "reclass_lines",
        "lines": [
          {
            "qbo_transaction_id": "...",
            "qbo_transaction_type": "...",
            "qbo_line_id": "...",
            "new_account_id": "...",
            "new_account_name": "...",
            "amount": number
          }
        ]
      }
      OR
      "proposed_fix": {
        "type": "journal_entry",
        "je": {
          "txn_date": "YYYY-MM-DD",
          "private_note": "Ironbooks: ...",
          "lines": [
            { "posting_type": "Debit" | "Credit", "amount": number, "account_id": "...", "account_name": "...", "description": "..." }
          ]
        }
      }
      OR
      "proposed_fix": { "type": "flag_for_manual", "notes": "what the bookkeeper should investigate" }
    }
  ]
}`;

export async function analyzeBs(params: {
  clientName: string;
  jurisdiction: string;
  stateProvince: string;
  realmId: string;
  accessToken: string;
  lookbackDays?: number;
}): Promise<{ result: AnalysisResult; snapshot: BsSnapshot; durationMs: number }> {
  const t0 = Date.now();
  const snapshot = await buildBsSnapshot(params);

  // Build a Set of valid account IDs so post-Claude validation can drop
  // hallucinated IDs without doing N×M scans.
  const validAccountIds = new Set<string>([
    ...snapshot.bs_accounts.map((a) => a.id),
    ...snapshot.categorization_targets.map((t) => t.id),
  ]);

  // Compact the snapshot for the prompt
  const compactSnapshot = {
    client: snapshot.client_name,
    jurisdiction: `${snapshot.jurisdiction} ${snapshot.state_province}`,
    today: new Date().toISOString().slice(0, 10),
    retained_earnings_account: snapshot.retained_earnings_account,
    bad_debt_account: snapshot.bad_debt_account,
    bs_accounts: snapshot.bs_accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.account_type,
      subtype: a.account_subtype,
      balance: Math.round(a.current_balance * 100) / 100,
      parent: a.parent_name,
    })),
    categorization_targets: snapshot.categorization_targets.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.account_type,
      subtype: t.account_subtype,
    })),
    suspect_transactions: Object.fromEntries(
      Object.entries(snapshot.suspect_transactions).map(([acctId, lines]) => [
        acctId,
        lines.map((l) => ({
          txn_id: l.transaction_id,
          txn_type: l.transaction_type,
          line_id: l.line_id,
          date: l.transaction_date,
          amount: l.transaction_amount,
          vendor: l.vendor_name,
          description: l.description,
          memo: l.private_note,
          is_reconciled: l.is_reconciled,
          is_bank_fed: l.is_bank_fed,
        })),
      ])
    ),
  };

  const userMessage = `Analyze this Balance Sheet snapshot and identify cleanup issues. Return your structured JSON.

${JSON.stringify(compactSnapshot, null, 2)}`;

  let parsed: AnalysisResult;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text response");
    }
    const raw = textBlock.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    parsed = JSON.parse(raw) as AnalysisResult;
  } catch (err: any) {
    throw new Error(`BS AI analysis failed: ${err?.message || String(err)}`);
  }

  // Validate + sanitize. Filter aggressively: any empty/malformed fix gets
  // downgraded to flag_for_manual so the bookkeeper doesn't get a
  // false-positive "executed" badge for an empty operation.
  const issues: Issue[] = [];
  const validationWarnings: string[] = [];
  for (const i of parsed.issues || []) {
    if (!i.kind || !i.proposed_fix) continue;

    let fix = i.proposed_fix as ProposedFix;
    const ftype = (fix as any)?.type;

    // Sanitize reclass_lines: drop lines with invalid account IDs or
    // bad amounts; if nothing remains, convert to flag_for_manual.
    if (ftype === "reclass_lines") {
      const rawLines = Array.isArray((fix as any).lines) ? (fix as any).lines : [];
      const goodLines = rawLines.filter((ln: any) => {
        if (!ln || !ln.qbo_transaction_id || !ln.qbo_line_id || !ln.new_account_id) return false;
        if (!validAccountIds.has(String(ln.new_account_id))) {
          validationWarnings.push(
            `Dropped reclass line with hallucinated account_id ${ln.new_account_id} (vendor: ${ln.vendor || "?"})`
          );
          return false;
        }
        const amt = Number(ln.amount);
        if (!Number.isFinite(amt) || amt === 0) return false;
        return true;
      });

      if (goodLines.length === 0) {
        fix = {
          type: "flag_for_manual",
          notes:
            i.ai_reasoning ||
            "AI proposed a reclass with no valid lines — review this account manually.",
        };
      } else {
        fix = { type: "reclass_lines", lines: goodLines.map(roundReclassLine) };
      }
    }

    // Sanitize journal_entry: validate accounts, balance debits/credits
    // to 2-decimal precision, drop unbalanced or empty.
    if (ftype === "journal_entry") {
      const je = (fix as any).je || {};
      const rawLines = Array.isArray(je.lines) ? je.lines : [];
      const goodLines = rawLines
        .map(roundJeLine)
        .filter((l: any) => {
          if (!l || !l.account_id) return false;
          if (!validAccountIds.has(String(l.account_id))) {
            validationWarnings.push(
              `Dropped JE line with hallucinated account_id ${l.account_id}`
            );
            return false;
          }
          if (!Number.isFinite(l.amount) || l.amount <= 0) return false;
          if (l.posting_type !== "Debit" && l.posting_type !== "Credit") return false;
          return true;
        });

      const debits = goodLines.filter((l: any) => l.posting_type === "Debit");
      const credits = goodLines.filter((l: any) => l.posting_type === "Credit");
      const debitSum = debits.reduce((s: number, l: any) => s + l.amount, 0);
      const creditSum = credits.reduce((s: number, l: any) => s + l.amount, 0);

      if (
        goodLines.length < 2 ||
        debits.length === 0 ||
        credits.length === 0 ||
        Math.abs(debitSum - creditSum) > 0.02
      ) {
        validationWarnings.push(
          `Dropped malformed JE (${goodLines.length} valid lines, debits=$${debitSum.toFixed(2)} vs credits=$${creditSum.toFixed(2)})`
        );
        fix = {
          type: "flag_for_manual",
          notes:
            i.ai_reasoning ||
            "AI proposed a JE that didn't balance or had invalid accounts — review manually.",
        };
      } else {
        fix = {
          type: "journal_entry",
          je: {
            txn_date: je.txn_date || new Date().toISOString().slice(0, 10),
            doc_number: je.doc_number,
            private_note: String(je.private_note || ""),
            lines: goodLines,
          },
        };
      }
    }

    if (ftype === "flag_for_manual") {
      fix = {
        type: "flag_for_manual",
        notes: String((fix as any).notes || i.description || ""),
      };
    }

    issues.push({
      kind: i.kind,
      account_qbo_id: i.account_qbo_id || null,
      account_name: i.account_name || null,
      description: String(i.description || ""),
      ai_reasoning: String(i.ai_reasoning || ""),
      confidence: Math.max(0, Math.min(1, Number(i.confidence) || 0)),
      risk: (["low", "medium", "high"].includes(i.risk) ? i.risk : "high") as Issue["risk"],
      estimated_impact: Math.abs(Number(i.estimated_impact) || 0),
      proposed_fix: fix,
    });
  }

  return {
    result: {
      issues,
      summary: String(parsed.summary || ""),
      warnings: [
        ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
        ...validationWarnings,
      ],
    },
    snapshot,
    durationMs: Date.now() - t0,
  };
}

// Small helpers: enforce 2-decimal precision so we never send 4-decimal
// floats to QBO and never trip the JE balance check on rounding noise.
function roundReclassLine(l: any) {
  return {
    qbo_transaction_id: String(l.qbo_transaction_id),
    qbo_transaction_type: String(l.qbo_transaction_type || ""),
    qbo_line_id: String(l.qbo_line_id),
    sync_token: l.sync_token ? String(l.sync_token) : undefined,
    new_account_id: String(l.new_account_id),
    new_account_name: String(l.new_account_name || ""),
    amount: Math.round(Number(l.amount) * 100) / 100,
  };
}
function roundJeLine(l: any) {
  return {
    posting_type: l?.posting_type,
    amount: Math.round(Number(l?.amount || 0) * 100) / 100,
    account_id: String(l?.account_id || ""),
    account_name: String(l?.account_name || ""),
    description: String(l?.description || ""),
  };
}

// ─── PRE-ACCEPT POLICY ─────────────────────────────────────────────────

/**
 * Conservative pre-accept rule (per user choice): confidence ≥ 0.95,
 * risk=low, and not touching a tax-sensitive account name.
 */
const TAX_SENSITIVE_PATTERNS = [
  /payroll/i,
  /tax/i,
  /owner/i,
  /draw/i,
  /distribution/i,
  /irs|cra/i,
];

export function shouldPreAccept(issue: Issue): boolean {
  if (issue.confidence < 0.95) return false;
  if (issue.risk !== "low") return false;
  const name = (issue.account_name || "").toLowerCase();
  if (TAX_SENSITIVE_PATTERNS.some((re) => re.test(name))) return false;
  // Don't pre-accept JE proposals — they're more consequential than line reclasses
  if (issue.proposed_fix.type === "journal_entry") return false;
  // Don't pre-accept flag_for_manual items (no fix to apply anyway)
  if (issue.proposed_fix.type === "flag_for_manual") return false;
  return true;
}
