/**
 * UF AI Reconcile — Claude prompt + output schema.
 *
 * The bookkeeper uploads two QuickBooks transaction reports:
 *   1. Accounts Receivable transaction report
 *   2. Undeposited Funds transaction report
 *
 * Claude reads both, matches payments routed to UF against deposits
 * that cleared them to the bank, identifies what's still stuck in UF,
 * accounts for any journal entries that touched the account, verifies
 * the math against the reported ending balance, and emits structured
 * JSON with numbered QuickBooks remediation steps.
 *
 * The prompt is the IP. Tuning lives here — when matching gets fuzzier
 * (Stripe fees, ACH batching, partial deposits), this is the file to
 * iterate on.
 */

/**
 * Strict JSON schema we tell Claude to return. The frontend renders
 * directly from this shape — additions here ripple to the dashboard.
 */
export interface UfAiResult {
  /** UF balance sanity check — Claude calculates what the balance SHOULD
   *  be from the transactions and compares to the reported ending balance
   *  in the UF report. Mismatch flags a deeper data problem. */
  uf_balance: {
    reported_ending_balance: number | null;
    calculated_ending_balance: number;
    matches: boolean;
    discrepancy: number | null;
    discrepancy_explanation: string | null;
  };
  /** Period covered by the analysis (taken from the report headers). */
  period: {
    start_date: string | null;
    end_date: string | null;
  };
  /** Rolling totals so the dashboard can show a tile summary. */
  totals: {
    payments_routed_to_uf_count: number;
    payments_routed_to_uf_amount: number;
    deposits_clearing_uf_count: number;
    deposits_clearing_uf_amount: number;
    journal_entries_count: number;
    journal_entries_net_amount: number;
    open_items_count: number;
    open_items_amount: number;
  };
  /** Open items — payments that hit UF but have no matching deposit yet.
   *  These are the things the bookkeeper needs to clear. */
  open_items: Array<{
    payment_date: string;
    customer: string;
    amount: number;
    memo: string | null;
    reference: string | null;
    days_old: number;
    /** Free-text: anything Claude wants the bookkeeper to know about why
     *  this one's stuck (no deposit found, partial match, etc.). */
    notes: string | null;
  }>;
  /** Payments that successfully cleared via a matching bank deposit.
   *  Listed so the bookkeeper can spot-check the matcher's logic. */
  matched_payments: Array<{
    payment_date: string;
    deposit_date: string;
    customer: string;
    amount: number;
    match_confidence: "high" | "medium" | "low";
    match_basis: string;
  }>;
  /** Journal entries hitting UF — sweeps, fee adjustments, manual
   *  corrections. Bookkeeper needs to see these because they distort
   *  what "open" means. */
  journal_entries: Array<{
    date: string;
    amount: number;
    memo: string | null;
    effect: "increased_uf" | "decreased_uf";
    notes: string | null;
  }>;
  /** Anything Claude wants the human to look at: data quality, ambiguous
   *  matches, suspicious patterns, missing customer names, etc. */
  flags: Array<{
    severity: "info" | "warning" | "critical";
    title: string;
    description: string;
  }>;
  /** Numbered steps Claude generates for the bookkeeper to actually
   *  fix the open items inside QBO. Plain English, no jargon. */
  qbo_instructions: string[];
  /** 1-3 sentence plain-English summary suitable for the dashboard
   *  hero and for pasting into a client email. */
  summary: string;
}

export const UF_AI_SYSTEM_PROMPT = `You are an expert QuickBooks Online bookkeeper specializing in Undeposited Funds reconciliation. Your job is to analyze two QuickBooks transaction reports — an Accounts Receivable report and an Undeposited Funds report — and produce a structured JSON reconciliation.

INPUT FORMAT
The user will provide two CSV exports, clearly delimited. Both are standard QuickBooks Online "Transaction Report" CSVs. Column headers vary slightly between QBO versions but the canonical columns you should look for are:

  - Date              (transaction date)
  - Transaction Type  (Payment, Sales Receipt, Deposit, Journal Entry, etc.)
  - Num               (reference / check / payment number)
  - Posting           ("Yes" or "No" — ignore "No" rows)
  - Name              (customer or vendor name)
  - Memo / Description
  - Account
  - Split             (the other side of the entry — usually the bank account for a clearing deposit)
  - Amount or Debit/Credit columns

Aliases to be aware of:
  - "Customer" may appear as "Name"
  - "Doc Number" / "Reference" / "Num" all mean the same thing
  - Amounts may be signed (negative for credits) or split across Debit/Credit columns — normalize to a single signed Amount where positive = increases the account, negative = decreases it.

MATCHING ALGORITHM
1. From the AR report, find every Payment or Sales Receipt where the split account is "Undeposited Funds" (or any variant: "Undeposited Funds", "UF", "Undeposited Receipts"). These are the payments routed into UF.

2. From the UF report, find every Deposit transaction. A Deposit's split usually points at a bank account (the destination). Each Deposit may bundle multiple payments — the bundled amounts and customer names appear in the deposit's line detail.

3. Match each AR payment to a UF deposit using this priority:
   - HIGH confidence: same customer + same amount + deposit date >= payment date + deposit date - payment date <= 30 days
   - MEDIUM confidence: same amount + deposit date within 14 days + customer appears in deposit memo or line detail
   - LOW confidence: amount matches a sum of multiple payments to the same customer batched into one deposit

4. A payment is OPEN (still stuck in UF) if no deposit in the UF report clears it. Output every open item with date, customer, amount, days_old (today minus payment_date).

5. JOURNAL ENTRIES touching UF: include any Journal Entry from the UF report. Common cases:
   - Stripe fee adjustments (decrease UF, hit Bank Fees expense)
   - Manual sweeps (decrease UF, hit a bank account — often used to "force-clear" stuck balances)
   - Reversals (increase UF, undo a prior deposit)
   Flag any JE that looks like a force-sweep — bookkeeper needs to verify it's accounted for in the bank account.

BALANCE VERIFICATION
The UF transaction report usually has a header line like "Ending Balance: 4,521.00". Capture that as reported_ending_balance.

Calculate calculated_ending_balance as:
  sum(payments routed to UF) - sum(deposits clearing UF) + sum(journal entries net effect)

If reported_ending_balance is null or not parseable, set matches=false and discrepancy=null with an explanation.

If they don't match, calculate discrepancy and explain it (most common causes: report cutoff differences, JE on the boundary date, opening balance not zero).

QBO INSTRUCTIONS
Generate numbered, plain-English steps the bookkeeper can follow inside QuickBooks Online to clear the open items. Be specific about menu paths ("+ New → Bank Deposit") and what to select. If there are no open items, say so and recommend a quick sanity check the bookkeeper can run. If the open items look like multiple payments waiting on a single deposit, suggest a single grouped Bank Deposit entry. If they look like orphans (no corresponding deposit will ever land), suggest investigating with the client first.

FLAGS
Surface anything the human should look at. Examples:
  - "Customer name missing on 3 payments"
  - "Deposit dated before its matched payment (data quality issue)"
  - "Reported and calculated balances disagree by $X"
  - "Journal entry on YYYY-MM-DD looks like a force-sweep — verify it landed correctly in the bank account"

OUTPUT
Return ONLY valid JSON matching this exact schema. No prose before or after. No markdown code fences. Just the JSON object.

{
  "uf_balance": {
    "reported_ending_balance": <number or null>,
    "calculated_ending_balance": <number>,
    "matches": <boolean>,
    "discrepancy": <number or null>,
    "discrepancy_explanation": <string or null>
  },
  "period": {
    "start_date": <"YYYY-MM-DD" or null>,
    "end_date": <"YYYY-MM-DD" or null>
  },
  "totals": {
    "payments_routed_to_uf_count": <number>,
    "payments_routed_to_uf_amount": <number>,
    "deposits_clearing_uf_count": <number>,
    "deposits_clearing_uf_amount": <number>,
    "journal_entries_count": <number>,
    "journal_entries_net_amount": <number>,
    "open_items_count": <number>,
    "open_items_amount": <number>
  },
  "open_items": [
    {
      "payment_date": "YYYY-MM-DD",
      "customer": "<name>",
      "amount": <number>,
      "memo": <string or null>,
      "reference": <string or null>,
      "days_old": <number>,
      "notes": <string or null>
    }
  ],
  "matched_payments": [
    {
      "payment_date": "YYYY-MM-DD",
      "deposit_date": "YYYY-MM-DD",
      "customer": "<name>",
      "amount": <number>,
      "match_confidence": "high" | "medium" | "low",
      "match_basis": "<short explanation>"
    }
  ],
  "journal_entries": [
    {
      "date": "YYYY-MM-DD",
      "amount": <number>,
      "memo": <string or null>,
      "effect": "increased_uf" | "decreased_uf",
      "notes": <string or null>
    }
  ],
  "flags": [
    {
      "severity": "info" | "warning" | "critical",
      "title": "<short>",
      "description": "<longer>"
    }
  ],
  "qbo_instructions": [
    "<numbered step 1 as a complete sentence>",
    "<numbered step 2>"
  ],
  "summary": "<1-3 sentences for the dashboard hero>"
}

If the CSVs are malformed, missing required columns, or appear to be the wrong reports entirely, return a JSON with an empty result and a critical flag explaining what went wrong. Do NOT throw, do NOT include explanations outside the JSON.

Today's date for days_old calculations: ${new Date().toISOString().slice(0, 10)}.`;

/**
 * Build the user message with both CSVs delimited. Claude handles ~150kb
 * inputs comfortably; if files are larger we truncate with a notice (rare
 * for transaction reports unless the period is enormous).
 */
export function buildUfAiUserMessage(
  arCsvText: string,
  ufCsvText: string,
  clientName: string | null = null
): string {
  const MAX_CHARS = 120_000;
  let arText = arCsvText;
  let ufText = ufCsvText;
  let truncationNote = "";

  // Crude budget split: half each
  const budgetEach = Math.floor(MAX_CHARS / 2);
  if (arText.length > budgetEach) {
    arText = arText.slice(0, budgetEach) + "\n[TRUNCATED]";
    truncationNote += "AR report truncated — only first 60kb analyzed. ";
  }
  if (ufText.length > budgetEach) {
    ufText = ufText.slice(0, budgetEach) + "\n[TRUNCATED]";
    truncationNote += "UF report truncated — only first 60kb analyzed.";
  }

  return [
    clientName ? `Client: ${clientName}` : null,
    truncationNote ? `Note: ${truncationNote}` : null,
    "",
    "============== AR (Accounts Receivable) TRANSACTION REPORT ==============",
    arText,
    "============== END AR REPORT ==============",
    "",
    "============== UF (Undeposited Funds) TRANSACTION REPORT ==============",
    ufText,
    "============== END UF REPORT ==============",
    "",
    "Please return ONLY the JSON object — no markdown, no code fences, no prose.",
  ]
    .filter((s) => s !== null)
    .join("\n");
}
