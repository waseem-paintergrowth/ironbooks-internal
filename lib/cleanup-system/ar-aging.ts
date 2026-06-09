/**
 * A/R Aging Summary recognition + reconciliation.
 *
 * A QuickBooks "A/R Aging Summary" report has NO invoice-level rows — just
 * one line per customer with aging-bucket columns (CURRENT / 1-30 / 31-60 /
 * 61-90 / 91+ / Total). It therefore can't drive the duplicate-invoice or
 * UF→A/R matchers (which need per-invoice data). Historically uploading one
 * into the A/R module silently produced zero entries.
 *
 * Instead of failing silently we (a) detect the format and (b) reconcile the
 * report's per-customer Total column against the live QBO open-invoice
 * balances, so the bookkeeper sees a tie-out (and is told the file isn't used
 * for matching).
 */

import type { OpenInvoice } from "@/lib/qbo-balance-sheet";

export interface AgingCustomerTotal {
  customer: string;
  total: number;
}

export interface ParsedArAging {
  customers: AgingCustomerTotal[];
  reportTotal: number | null;
  asOf: string | null;
}

export interface AgingReconRow {
  customer: string;
  aging_total: number | null;
  qbo_open_balance: number | null;
  difference: number; // aging_total - qbo_open_balance
  status: "match" | "aging_only" | "qbo_only" | "mismatch";
}

export interface AgingReconciliation {
  type: "ar_aging_reconciliation";
  v: 1;
  as_of: string | null;
  aging_report_total: number | null;
  qbo_open_total: number;
  difference: number; // aging_report_total - qbo_open_total
  matched: number;
  mismatched: number;
  aging_only: number;
  qbo_only: number;
  rows: AgingReconRow[];
  message: string;
}

const AMOUNT_TOLERANCE = 0.5;

function normalizeName(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co\.?|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(val: string | undefined): number | null {
  if (val === undefined) return null;
  const cleaned = val.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  // Accounting-style negatives in parentheses, e.g. (150.00)
  const paren = /^\((.*)\)$/.exec(cleaned);
  const n = parseFloat(paren ? `-${paren[1]}` : cleaned);
  return isNaN(n) ? null : n;
}

/** Minimal CSV row splitter (handles quoted fields with embedded commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; continue; }
        inQ = false; continue;
      }
      field += ch; continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ",") { out.push(field); field = ""; continue; }
    field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Heuristic: an A/R Aging Summary if some header row contains the aging
 * bucket columns. We look for a row that has "current" plus at least one
 * range bucket and a "total" column.
 */
export function isArAgingSummary(csvText: string): boolean {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/).slice(0, 12);
  for (const line of lines) {
    const cells = splitCsvLine(line).map((c) => c.toLowerCase());
    const hasCurrent = cells.some((c) => c === "current");
    const hasBucket = cells.some((c) => /^\d+\s*-\s*\d+$/.test(c) || /91\s*and\s*over/.test(c));
    const hasTotal = cells.some((c) => c === "total");
    if (hasCurrent && hasBucket && hasTotal) return true;
  }
  return false;
}

/**
 * Parse the per-customer Total column out of an A/R Aging Summary export.
 * Returns customers (excluding the grand TOTAL row) plus the report total.
 */
export function parseArAgingSummary(csvText: string): ParsedArAging {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/);
  let headerIdx = -1;
  let totalCol = -1;

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cells = splitCsvLine(lines[i]).map((c) => c.toLowerCase());
    const tIdx = cells.findIndex((c) => c === "total");
    const hasCurrent = cells.some((c) => c === "current");
    if (tIdx >= 0 && hasCurrent) {
      headerIdx = i;
      totalCol = tIdx;
      break;
    }
  }

  // "As of <date>" line, if present
  let asOf: string | null = null;
  for (let i = 0; i < Math.min(lines.length, headerIdx >= 0 ? headerIdx : 6); i++) {
    const m = /as of\s+(.+?)\s*,?\s*$/i.exec(splitCsvLine(lines[i])[0] || "");
    if (m) { asOf = m[1].trim(); break; }
  }

  const customers: AgingCustomerTotal[] = [];
  let reportTotal: number | null = null;

  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const name = (cells[0] || "").trim();
      if (!name) continue;
      const amount = parseAmount(cells[totalCol]);
      if (amount === null) continue;
      if (/^total$/i.test(name)) { reportTotal = amount; continue; }
      customers.push({ customer: name, total: amount });
    }
  }

  return { customers, reportTotal, asOf };
}

/**
 * Tie the aging report's per-customer totals out against live QBO open
 * invoice balances (grouped by customer).
 */
export function reconcileAgingAgainstQbo(
  parsed: ParsedArAging,
  invoices: OpenInvoice[]
): AgingReconciliation {
  // Group QBO open balances by normalized customer name.
  const qboByCustomer = new Map<string, { display: string; balance: number }>();
  for (const inv of invoices) {
    const key = normalizeName(inv.customer_name);
    if (!key) continue;
    const prev = qboByCustomer.get(key);
    qboByCustomer.set(key, {
      display: inv.customer_name || prev?.display || key,
      balance: (prev?.balance || 0) + Number(inv.balance || 0),
    });
  }

  const seenQbo = new Set<string>();
  const rows: AgingReconRow[] = [];

  for (const c of parsed.customers) {
    const key = normalizeName(c.customer);
    const qbo = qboByCustomer.get(key);
    if (qbo) seenQbo.add(key);
    const qboBal = qbo ? qbo.balance : null;
    const diff = c.total - (qboBal ?? 0);
    let status: AgingReconRow["status"];
    if (qboBal === null) status = "aging_only";
    else if (Math.abs(diff) <= AMOUNT_TOLERANCE) status = "match";
    else status = "mismatch";
    rows.push({
      customer: c.customer,
      aging_total: c.total,
      qbo_open_balance: qboBal,
      difference: Number(diff.toFixed(2)),
      status,
    });
  }

  // Customers with QBO open balance but no aging-report row.
  for (const [key, val] of qboByCustomer.entries()) {
    if (seenQbo.has(key)) continue;
    if (Math.abs(val.balance) <= AMOUNT_TOLERANCE) continue;
    rows.push({
      customer: val.display,
      aging_total: null,
      qbo_open_balance: Number(val.balance.toFixed(2)),
      difference: Number((-val.balance).toFixed(2)),
      status: "qbo_only",
    });
  }

  rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  const qboOpenTotal = invoices.reduce((s, inv) => s + Number(inv.balance || 0), 0);
  const matched = rows.filter((r) => r.status === "match").length;
  const mismatched = rows.filter((r) => r.status === "mismatch").length;
  const agingOnly = rows.filter((r) => r.status === "aging_only").length;
  const qboOnly = rows.filter((r) => r.status === "qbo_only").length;
  const grandDiff = Number(((parsed.reportTotal ?? 0) - qboOpenTotal).toFixed(2));

  const tied = parsed.reportTotal !== null && Math.abs(grandDiff) <= AMOUNT_TOLERANCE;
  const message = tied
    ? `A/R Aging Summary ties out to QuickBooks (total $${qboOpenTotal.toFixed(2)}). This report is a tie-out check only — it isn't used for matching. To clear Undeposited Funds to A/R, just run Discover (it reads QuickBooks directly).`
    : `A/R Aging Summary total ${parsed.reportTotal !== null ? `$${parsed.reportTotal.toFixed(2)}` : "(unknown)"} vs QuickBooks open A/R $${qboOpenTotal.toFixed(2)} — difference $${grandDiff.toFixed(2)}. Review the per-customer rows below. This report isn't used for matching; UF→A/R clearing reads QuickBooks directly.`;

  return {
    type: "ar_aging_reconciliation",
    v: 1,
    as_of: parsed.asOf,
    aging_report_total: parsed.reportTotal,
    qbo_open_total: Number(qboOpenTotal.toFixed(2)),
    difference: grandDiff,
    matched,
    mismatched,
    aging_only: agingOnly,
    qbo_only: qboOnly,
    rows,
    message,
  };
}
