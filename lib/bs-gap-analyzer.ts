import type { AccountTransaction } from "./qbo-balance-sheet";

/**
 * Heuristic gap-analysis for a reconciliation discrepancy.
 *
 * Given the QBO transactions hitting an account over the statement
 * window AND the known gap amount (statement - QBO), surface the
 * specific transactions most likely to be causing it. No AI needed —
 * the most useful flags are pattern-matched:
 *
 *  - **Same-date / same-amount duplicates**: two entries on the same
 *    day with the same absolute amount. Classic duplicate-deposit
 *    pattern (one from bank feed, one manually entered).
 *
 *  - **Round-number plug entries**: amounts ending in .00 with no
 *    payee. Common bookkeeper shortcut that QBO doesn't validate.
 *
 *  - **Uncleared transactions**: items in QBO that don't have the
 *    cleared/reconciled flag. Worth scrutinizing first.
 *
 *  - **Gap-amount matches**: any single transaction whose amount
 *    equals the gap (or its negative). One-shot fix candidates.
 *
 *  - **Outliers**: transactions more than 3σ from the median amount.
 *    Possible typos or one-off issues.
 *
 * Returns ranked candidates with a `weight` 0-1 — the UI uses this
 * to sort and to surface the most likely culprits first.
 */

export interface GapCandidate {
  txn: AccountTransaction;
  weight: number;
  reasons: string[];
}

export interface GapAnalysis {
  total_transactions: number;
  uncleared_count: number;
  uncleared_total: number;
  candidates: GapCandidate[];
  notes: string[];
}

export function analyzeGap(
  transactions: AccountTransaction[],
  gapAmount: number
): GapAnalysis {
  const notes: string[] = [];
  const candidates = new Map<string, GapCandidate>();

  // Helper to add or boost a candidate
  function addCandidate(txn: AccountTransaction, weight: number, reason: string) {
    const key = txn.txn_id || `${txn.date}-${txn.amount}-${txn.memo}`;
    const existing = candidates.get(key);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + weight * 0.5);
      existing.reasons.push(reason);
    } else {
      candidates.set(key, { txn, weight, reasons: [reason] });
    }
  }

  const absGap = Math.abs(gapAmount);

  // ── 1. Same-date / same-absolute-amount duplicates ──
  const byDateAmount = new Map<string, AccountTransaction[]>();
  for (const t of transactions) {
    const key = `${t.date}|${Math.abs(t.amount).toFixed(2)}`;
    const arr = byDateAmount.get(key) || [];
    arr.push(t);
    byDateAmount.set(key, arr);
  }
  for (const [, dups] of byDateAmount) {
    if (dups.length < 2) continue;
    for (const t of dups) {
      addCandidate(
        t,
        0.85,
        `Same date + amount as ${dups.length - 1} other entr${dups.length === 2 ? "y" : "ies"} — likely duplicate`
      );
    }
  }

  // ── 2. Exact gap-amount match ──
  // If a single transaction equals the gap, it's the most likely
  // culprit (either it's missing or duplicated).
  if (absGap > 0.005) {
    for (const t of transactions) {
      if (Math.abs(Math.abs(t.amount) - absGap) < 0.01) {
        addCandidate(
          t,
          0.95,
          `Amount matches the gap exactly — single-transaction explanation`
        );
      }
    }
  }

  // ── 3. Uncleared transactions ──
  const uncleared = transactions.filter((t) => !t.cleared);
  const unclearedTotal = uncleared.reduce((s, t) => s + t.amount, 0);
  for (const t of uncleared) {
    addCandidate(
      t,
      0.4,
      "Not marked cleared in QBO — review whether it actually hit the bank"
    );
  }
  if (uncleared.length > 0) {
    notes.push(
      `${uncleared.length} transaction${uncleared.length === 1 ? "" : "s"} in this window aren't marked cleared, totaling $${Math.abs(unclearedTotal).toFixed(2)}.`
    );
  }

  // ── 4. Round-number plug entries (no payee, ends in .00) ──
  for (const t of transactions) {
    const dollars = Math.abs(t.amount);
    if (dollars < 1) continue;
    if (Math.abs(dollars - Math.round(dollars)) > 0.005) continue;
    if (!t.customer_or_vendor || t.customer_or_vendor.trim() === "") {
      addCandidate(
        t,
        0.5,
        "Round amount with no payee — possible plug entry"
      );
    }
  }

  // ── 5. Statistical outliers ──
  // Compute median absolute amount and σ; flag txns > 3σ from median.
  if (transactions.length >= 6) {
    const sorted = [...transactions]
      .map((t) => Math.abs(t.amount))
      .sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = sorted.reduce((s, n) => s + n, 0) / sorted.length;
    const variance =
      sorted.reduce((s, n) => s + (n - mean) ** 2, 0) / sorted.length;
    const sigma = Math.sqrt(variance);
    const threshold = median + 3 * sigma;
    for (const t of transactions) {
      if (Math.abs(t.amount) > threshold && Math.abs(t.amount) > 500) {
        addCandidate(
          t,
          0.35,
          `Amount is unusually large for this account (median $${median.toFixed(0)}, ${(Math.abs(t.amount) / median).toFixed(1)}x larger)`
        );
      }
    }
  }

  // Sort by weight descending
  const ranked = Array.from(candidates.values()).sort(
    (a, b) => b.weight - a.weight
  );

  if (ranked.length === 0 && absGap > 0.5) {
    notes.push(
      `No obvious duplicate/outlier patterns detected. Gap may be from transactions outside the statement window, missing bank-feed entries, or a forced Opening Balance Equity adjustment. Pull a transaction list directly from QBO and compare to the bank statement line-by-line.`
    );
  }

  return {
    total_transactions: transactions.length,
    uncleared_count: uncleared.length,
    uncleared_total: unclearedTotal,
    candidates: ranked.slice(0, 25), // top 25
    notes,
  };
}
