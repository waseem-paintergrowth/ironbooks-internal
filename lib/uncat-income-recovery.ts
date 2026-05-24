/**
 * Uncategorized Income Recovery
 * ==============================
 *
 * Finds deposits + JEs that landed in "Uncategorized Income" because the
 * previous bookkeeper didn't know who the customer was. Matches them against
 * open A/R invoices so the bookkeeper can apply the payment and clean up
 * both Uncat Income AND A/R Aging in one pass.
 *
 * Distinct from UF Audit:
 *   - UF Audit: money never reached the bank (no deposit recorded)
 *   - This:     money DID reach the bank, but landed in the wrong account
 *
 * Classification:
 *   - exact_single  — exactly 1 open invoice matches the amount
 *   - exact_multi   — 2+ open invoices match the amount
 *   - ai_inferred   — Claude inferred a customer from description text
 *   - no_match      — nothing matches
 */

import Anthropic from "@anthropic-ai/sdk";
import { qboRateLimiter } from "./qbo";
import { fetchOpenInvoices, type OpenInvoice } from "./qbo-balance-sheet";
import { fetchAllCustomers, type QBOCustomerLite } from "./qbo-stripe-recon";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status} on ${endpoint}: ${body}`);
  }
  return res.json();
}

// ─── TYPES ─────────────────────────────────────────────────────────────

export interface UncatIncomeRawItem {
  qbo_txn_id: string;
  qbo_txn_type: string;       // 'Deposit' or 'JournalEntry'
  qbo_line_id: string | null;
  sync_token: string | null;
  txn_date: string;
  amount: number;
  description: string;
  private_note: string;
  bank_account_id: string | null;
  bank_account_name: string | null;
  customer_qbo_id: string | null;
  customer_name: string | null;
}

export interface InvoiceCandidate {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_qbo_id: string | null;
  customer_name: string | null;
  txn_date: string;
  balance: number;
}

export type Classification = "exact_single" | "exact_multi" | "ai_inferred" | "no_match";

export interface ClassifiedItem extends UncatIncomeRawItem {
  classification: Classification;
  candidates: InvoiceCandidate[];
  auto_approve_eligible: boolean;
}

export interface UncatIncomeScanResult {
  uncat_account_qbo_id: string;
  uncat_account_name: string;
  scan_from: string;
  scan_to: string;
  deposits_scanned: number;
  open_invoices_scanned: number;
  total_uncat_amount: number;
  exact_single_count: number;
  exact_multi_count: number;
  no_match_count: number;
  items: ClassifiedItem[];
  open_invoices: OpenInvoice[];
}

// ─── ACCOUNT LOOKUP ────────────────────────────────────────────────────

/**
 * Find the Uncategorized Income account. QBO doesn't use a specific
 * AccountSubType, so we name-match. Returns null if not found.
 */
export async function findUncategorizedIncomeAccount(
  realmId: string,
  accessToken: string
): Promise<{ id: string; name: string } | null> {
  const query = encodeURIComponent(
    `SELECT Id, Name, AccountType FROM Account WHERE AccountType = 'Income' AND Active = true`
  );
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const rows: any[] = data?.QueryResponse?.Account || [];
  // Prefer exact "Uncategorized Income"; fall back to name patterns.
  const exact = rows.find((a) => /^uncategori[sz]ed\s+income$/i.test(a.Name));
  if (exact) return { id: exact.Id, name: exact.Name };
  const fuzzy = rows.find((a) => /uncategori[sz]ed/i.test(a.Name));
  if (fuzzy) return { id: fuzzy.Id, name: fuzzy.Name };
  return null;
}

// ─── SOURCE TXN FETCH ──────────────────────────────────────────────────

/**
 * Fetch every Deposit and JE that has a line hitting the Uncat Income account.
 *
 * QBO can't filter by line account directly, so we pull Deposits + JEs in
 * the window, then filter the lines client-side.
 */
async function fetchUncatIncomeLines(
  realmId: string,
  accessToken: string,
  uncatAccountId: string,
  since: string
): Promise<UncatIncomeRawItem[]> {
  const out: UncatIncomeRawItem[] = [];

  async function fetchPaged(table: "Deposit" | "JournalEntry"): Promise<any[]> {
    const rows: any[] = [];
    let page = 0;
    const pageSize = 200;
    while (true) {
      const startPosition = page * pageSize + 1;
      const query = encodeURIComponent(
        `SELECT * FROM ${table} WHERE TxnDate >= '${since}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      );
      let data: any;
      try {
        data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
      } catch (err: any) {
        console.warn(`[uncat-income] ${table} query failed:`, err?.message);
        break;
      }
      const batch: any[] = data?.QueryResponse?.[table] || [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      page++;
      if (page > 50) break;
    }
    return rows;
  }

  // ─── DEPOSITS ───
  // A Deposit has a DepositToAccountRef (the bank) and Line[] items each with
  // an AccountRef. We want Lines where AccountRef = uncatAccountId.
  const deposits = await fetchPaged("Deposit");
  for (const d of deposits) {
    const bankRef = d.DepositToAccountRef || {};
    const lines: any[] = Array.isArray(d.Line) ? d.Line : [];
    for (const line of lines) {
      const detail = line.DepositLineDetail || {};
      const acctRef = detail.AccountRef;
      if (!acctRef || String(acctRef.value) !== String(uncatAccountId)) continue;

      out.push({
        qbo_txn_id: String(d.Id),
        qbo_txn_type: "Deposit",
        qbo_line_id: line.Id ? String(line.Id) : null,
        sync_token: d.SyncToken != null ? String(d.SyncToken) : null,
        txn_date: String(d.TxnDate || ""),
        amount: Number(line.Amount || 0),
        description: String(line.Description || ""),
        private_note: String(d.PrivateNote || ""),
        bank_account_id: bankRef?.value || null,
        bank_account_name: bankRef?.name || null,
        customer_qbo_id: detail.Entity?.value || null,
        customer_name: detail.Entity?.name || null,
      });
    }
  }

  // ─── JOURNAL ENTRIES ───
  const jes = await fetchPaged("JournalEntry");
  for (const je of jes) {
    const lines: any[] = Array.isArray(je.Line) ? je.Line : [];
    for (const line of lines) {
      const detail = line.JournalEntryLineDetail || {};
      const acctRef = detail.AccountRef;
      if (!acctRef || String(acctRef.value) !== String(uncatAccountId)) continue;

      // For Uncat Income (income account), we care about CREDIT postings
      // — that's money coming into the income account. Debits would be
      // someone REMOVING from Uncat Income (already a cleanup move).
      const posting = detail.PostingType;
      if (posting && posting !== "Credit") continue;

      out.push({
        qbo_txn_id: String(je.Id),
        qbo_txn_type: "JournalEntry",
        qbo_line_id: line.Id ? String(line.Id) : null,
        sync_token: je.SyncToken != null ? String(je.SyncToken) : null,
        txn_date: String(je.TxnDate || ""),
        amount: Number(line.Amount || 0),
        description: String(line.Description || ""),
        private_note: String(je.PrivateNote || ""),
        bank_account_id: null,
        bank_account_name: null,
        customer_qbo_id: detail.Entity?.EntityRef?.value || null,
        customer_name: detail.Entity?.EntityRef?.name || null,
      });
    }
  }

  return out;
}

// ─── MATCHER ───────────────────────────────────────────────────────────

const AMOUNT_TOLERANCE = 0.01;
const DATE_WINDOW_DAYS = 60; // open invoice within ±60d of deposit
const AUTO_APPROVE_MAX = 10_000;

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs((da - db) / 86_400_000);
}

function classifyDeterministic(
  item: UncatIncomeRawItem,
  openInvoices: OpenInvoice[]
): { classification: Classification; candidates: InvoiceCandidate[] } {
  // Filter by amount first (tight tolerance)
  let candidates = openInvoices.filter(
    (inv) => Math.abs(inv.balance - item.amount) <= AMOUNT_TOLERANCE
  );

  // If we have a known customer on the deposit, restrict to that customer
  if (item.customer_qbo_id) {
    const sameCustomer = candidates.filter(
      (inv) => inv.customer_id === item.customer_qbo_id
    );
    if (sameCustomer.length > 0) candidates = sameCustomer;
  }

  // Sort by date proximity
  const annotated: InvoiceCandidate[] = candidates
    .map((inv) => ({
      qbo_invoice_id: inv.qbo_invoice_id,
      doc_number: inv.doc_number,
      customer_qbo_id: inv.customer_id,
      customer_name: inv.customer_name,
      txn_date: inv.txn_date,
      balance: inv.balance,
    }))
    .sort(
      (a, b) =>
        daysBetween(item.txn_date, a.txn_date) -
        daysBetween(item.txn_date, b.txn_date)
    );

  // Drop candidates outside the date window (too far apart to be plausibly
  // the same money flow)
  const inWindow = annotated.filter(
    (c) => daysBetween(item.txn_date, c.txn_date) <= DATE_WINDOW_DAYS
  );
  const finalCandidates = inWindow.length > 0 ? inWindow : annotated.slice(0, 5);

  if (finalCandidates.length === 0) {
    return { classification: "no_match", candidates: [] };
  }
  if (finalCandidates.length === 1) {
    return { classification: "exact_single", candidates: finalCandidates };
  }
  return { classification: "exact_multi", candidates: finalCandidates.slice(0, 10) };
}

// ─── CLAUDE CUSTOMER INFERENCE (with hard safety rails) ────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-opus-4-7";
const CLAUDE_HARD_TIMEOUT_MS = 90_000;
const CLAUDE_MAX_ITEMS = 60;

export interface AiInferenceResult {
  status: "success" | "partial" | "timeout" | "failed" | "skipped";
  itemsConsidered: number;
  itemsInferred: number;
  durationMs: number;
  errorMessage: string | null;
  /** Map from qbo_txn_id+qbo_line_id (joined by "|") to inferred customer. */
  inferred: Map<string, {
    customer_qbo_id: string;
    customer_name: string;
    confidence: number;
    reasoning: string;
  }>;
}

/**
 * Use Claude to look at descriptions of no-match items and try to infer
 * a customer from the customer list. SAFETY RAILS:
 *   - Hard timeout via Promise.race (never hangs the request)
 *   - Bounded input size (≤ CLAUDE_MAX_ITEMS items)
 *   - All errors caught and surfaced via status field
 *   - Caller MUST check result.status and show banner if not "success"
 *   - No silent skip: even "no API key" returns status:"skipped" with reason
 */
export async function inferCustomersWithClaude(params: {
  items: ClassifiedItem[];
  customers: QBOCustomerLite[];
  openInvoices: OpenInvoice[];
}): Promise<AiInferenceResult> {
  const t0 = Date.now();
  const result: AiInferenceResult = {
    status: "success",
    itemsConsidered: 0,
    itemsInferred: 0,
    durationMs: 0,
    errorMessage: null,
    inferred: new Map(),
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    result.status = "skipped";
    result.errorMessage = "ANTHROPIC_API_KEY not configured";
    result.durationMs = Date.now() - t0;
    return result;
  }

  // Candidates: items without a known customer that the deterministic
  // matcher couldn't resolve. (If we already have a customer or already
  // matched a single invoice, Claude adds nothing.)
  const candidates = params.items.filter(
    (i) =>
      !i.customer_qbo_id &&
      (i.classification === "no_match" || i.classification === "exact_multi") &&
      (i.description || i.private_note).trim().length > 0
  );

  if (candidates.length === 0) {
    result.status = "skipped";
    result.errorMessage = "No items needed AI inference";
    result.durationMs = Date.now() - t0;
    return result;
  }

  const trimmed = candidates.slice(0, CLAUDE_MAX_ITEMS);
  result.itemsConsidered = trimmed.length;

  // Compact customer list for prompt — only DisplayName needed for matching.
  const customersForPrompt = params.customers.map((c) => ({
    id: c.id,
    name: c.display_name,
  }));

  const itemsForPrompt = trimmed.map((i, idx) => ({
    idx,
    key: `${i.qbo_txn_id}|${i.qbo_line_id || ""}`,
    date: i.txn_date,
    amount: i.amount,
    description: i.description || "",
    private_note: i.private_note || "",
  }));

  const systemPrompt = `You are a forensic bookkeeper. The user gives you bank deposit / journal entry descriptions that landed in "Uncategorized Income" — and a list of valid QBO customers. Your job: infer which customer paid, when the description hints at one.

RULES:
- ONLY infer a customer if the description clearly identifies one (e.g. "ACH MARTEL CONST 38136" → Martel Construction).
- NEVER guess. If the description is generic ("CHECK DEPOSIT", "ACH PAYMENT", a raw number) → omit the item entirely.
- Customer match must be one in the provided list. Use the id field exactly as given.
- Confidence: 0.95+ only if the customer name appears nearly verbatim. 0.7-0.94 if it's a clear abbreviation. Below 0.7 → don't return it.

Return STRICTLY this JSON:
{
  "inferences": [
    { "key": "<the key from the item>", "customer_id": "<id>", "customer_name": "<name>", "confidence": 0.0-1.0, "reasoning": "1 sentence" }
  ]
}

No markdown. No preamble.`;

  const userMessage = `Customers (id, name):
${JSON.stringify(customersForPrompt, null, 2)}

Deposits to identify:
${JSON.stringify(itemsForPrompt, null, 2)}`;

  // Hard timeout race
  const claudePromise = anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  let response: any;
  try {
    response = await Promise.race([
      claudePromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Claude inference timed out after ${CLAUDE_HARD_TIMEOUT_MS}ms`)),
          CLAUDE_HARD_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err: any) {
    const isTimeout = /timed out/i.test(err?.message || "");
    result.status = isTimeout ? "timeout" : "failed";
    result.errorMessage = err?.message || String(err);
    result.durationMs = Date.now() - t0;
    return result;
  }

  // Parse response — wrap in try/catch so a bad JSON response surfaces
  // visibly rather than silently dropping inferences.
  try {
    const textBlock = response.content.find((c: any) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text response");
    }
    const raw = textBlock.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(raw);
    const inferences: any[] = Array.isArray(parsed.inferences) ? parsed.inferences : [];

    const validCustomerIds = new Set(params.customers.map((c) => c.id));
    let droppedHallucinations = 0;
    for (const inf of inferences) {
      if (!inf || !inf.key || !inf.customer_id) continue;
      if (!validCustomerIds.has(String(inf.customer_id))) {
        droppedHallucinations++;
        continue;
      }
      const conf = Number(inf.confidence);
      if (!Number.isFinite(conf) || conf < 0.7) continue;
      result.inferred.set(String(inf.key), {
        customer_qbo_id: String(inf.customer_id),
        customer_name: String(inf.customer_name || ""),
        confidence: conf,
        reasoning: String(inf.reasoning || ""),
      });
    }
    result.itemsInferred = result.inferred.size;
    if (droppedHallucinations > 0) {
      result.status = "partial";
      result.errorMessage = `Dropped ${droppedHallucinations} inference(s) with hallucinated customer IDs.`;
    }
  } catch (err: any) {
    result.status = "failed";
    result.errorMessage = `Failed to parse Claude response: ${err?.message || String(err)}`;
  }

  result.durationMs = Date.now() - t0;
  return result;
}

// ─── ORCHESTRATOR ──────────────────────────────────────────────────────

/**
 * Full scan: pull source txns, pull open invoices, deterministic match,
 * optional Claude pass (caller decides). Returns the result + AI status
 * separately so the route can persist both.
 */
export async function scanUncatIncome(
  realmId: string,
  accessToken: string,
  uncatAccount: { id: string; name: string },
  options?: { lookbackDays?: number }
): Promise<UncatIncomeScanResult> {
  const lookbackDays = options?.lookbackDays ?? 730;
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [rawItems, openInvoices] = await Promise.all([
    fetchUncatIncomeLines(realmId, accessToken, uncatAccount.id, since),
    fetchOpenInvoices(realmId, accessToken),
  ]);

  const items: ClassifiedItem[] = [];
  let total = 0;
  let exactSingle = 0;
  let exactMulti = 0;
  let noMatch = 0;

  for (const raw of rawItems) {
    total += raw.amount;
    const { classification, candidates } = classifyDeterministic(raw, openInvoices);
    const autoApprove =
      classification === "exact_single" &&
      raw.amount > 0 &&
      raw.amount < AUTO_APPROVE_MAX;
    if (classification === "exact_single") exactSingle++;
    else if (classification === "exact_multi") exactMulti++;
    else if (classification === "no_match") noMatch++;
    items.push({
      ...raw,
      classification,
      candidates,
      auto_approve_eligible: autoApprove,
    });
  }

  // Sort: needs-input first (no_match, exact_multi), then exact_single, then biggest amount
  items.sort((a, b) => {
    const rank = (c: Classification) =>
      c === "no_match" ? 0 : c === "exact_multi" ? 1 : c === "ai_inferred" ? 2 : 3;
    const r = rank(a.classification) - rank(b.classification);
    if (r !== 0) return r;
    return b.amount - a.amount;
  });

  return {
    uncat_account_qbo_id: uncatAccount.id,
    uncat_account_name: uncatAccount.name,
    scan_from: since,
    scan_to: today,
    deposits_scanned: rawItems.length,
    open_invoices_scanned: openInvoices.length,
    total_uncat_amount: Math.round(total * 100) / 100,
    exact_single_count: exactSingle,
    exact_multi_count: exactMulti,
    no_match_count: noMatch,
    items,
    open_invoices: openInvoices,
  };
}

/**
 * Apply AI inference results to items: items that Claude inferred a customer
 * for are re-classified as "ai_inferred" and given that customer's open
 * invoices as candidates.
 */
export function applyAiInferences(
  items: ClassifiedItem[],
  inference: AiInferenceResult,
  openInvoices: OpenInvoice[]
): ClassifiedItem[] {
  if (inference.inferred.size === 0) return items;
  return items.map((item) => {
    const key = `${item.qbo_txn_id}|${item.qbo_line_id || ""}`;
    const hit = inference.inferred.get(key);
    if (!hit) return item;
    // Pull this customer's open invoices (any amount, sorted by date proximity)
    const customerInvoices = openInvoices
      .filter((inv) => inv.customer_id === hit.customer_qbo_id)
      .map((inv) => ({
        qbo_invoice_id: inv.qbo_invoice_id,
        doc_number: inv.doc_number,
        customer_qbo_id: inv.customer_id,
        customer_name: inv.customer_name,
        txn_date: inv.txn_date,
        balance: inv.balance,
      }))
      .sort(
        (a, b) =>
          daysBetween(item.txn_date, a.txn_date) -
          daysBetween(item.txn_date, b.txn_date)
      )
      .slice(0, 10);
    return {
      ...item,
      classification: "ai_inferred",
      customer_qbo_id: hit.customer_qbo_id,
      customer_name: hit.customer_name,
      candidates: customerInvoices,
      auto_approve_eligible: false, // never auto-approve AI inferences
    };
  });
}

export { fetchAllCustomers };
