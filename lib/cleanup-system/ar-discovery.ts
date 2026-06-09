/**
 * Accounts Receivable discovery — duplicate invoice detection (CRM + heuristic).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  detectDuplicates,
  normalizeCrmRows,
  parseCsv,
  type CrmSource,
} from "@/lib/hardcore-cleanup";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import { createProposedEntry } from "./proposed-entries";
import {
  duplicateConfidenceToDecision,
  serializeMeta,
  type ArDuplicateMeta,
} from "./entry-meta";
import { fetchUfAndInvoices, proposeUfArMatches } from "./uf-discovery";
import {
  isArAgingSummary,
  parseArAgingSummary,
  reconcileAgingAgainstQbo,
} from "./ar-aging";

export interface ArDiscoverOptions {
  crmSource?: CrmSource;
  crmCsvText?: string;
}

export async function discoverAccountsReceivableModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string,
  options: ArDiscoverOptions = {}
): Promise<{ proposed: number; duplicates: number }> {
  const { invoices, ufPayments } = await fetchUfAndInvoices(service, clientLinkId);

  // The A/R module accepts an optional CRM export. A QuickBooks "A/R Aging
  // Summary" report (per-customer totals, no invoice rows) can't drive
  // matching — if that's what was uploaded, reconcile it against QBO and
  // store a tie-out note instead of silently parsing nothing.
  let discoveryNotes: Record<string, unknown> | null = null;
  let crmJobs: ReturnType<typeof normalizeCrmRows> = [];
  if (options.crmCsvText?.trim()) {
    if (isArAgingSummary(options.crmCsvText)) {
      const parsed = parseArAgingSummary(options.crmCsvText);
      discoveryNotes = reconcileAgingAgainstQbo(parsed, invoices) as any;
    } else if (options.crmSource) {
      const rows = parseCsv(options.crmCsvText);
      crmJobs = normalizeCrmRows(rows, options.crmSource);
    }
  }

  const { duplicates } = detectDuplicates({ crmJobs, qboInvoices: invoices });
  let proposed = 0;

  for (const dup of duplicates) {
    const inv = dup.qbo_invoice;
    const meta: ArDuplicateMeta = {
      v: 1,
      type: "ar_duplicate",
      reasoning: dup.reasoning,
      survivor_invoice_id: dup.surviving_qbo_invoice.qbo_invoice_id,
      survivor_doc_number: dup.surviving_qbo_invoice.doc_number,
      confidence: dup.confidence,
    };

    let cpaFlagId: string | undefined;
    if (inv.txn_date && requiresCpaFlag(inv.txn_date, periodLockDate, "income")) {
      cpaFlagId = await createCpaFlag(service, {
        clientLinkId,
        runId,
        flagType: "prior_year_income",
        description: `Duplicate invoice ${inv.doc_number || inv.qbo_invoice_id} dated ${inv.txn_date} is in a closed period`,
      });
    }

    const decision = cpaFlagId ? "flagged" : duplicateConfidenceToDecision(dup.confidence);

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "accounts_receivable",
      entryType: "void",
      amount: Number(inv.balance || inv.total_amount || 0),
      txnDate: inv.txn_date,
      memo: `Void duplicate invoice #${inv.doc_number || inv.qbo_invoice_id} (keep #${dup.surviving_qbo_invoice.doc_number || dup.surviving_qbo_invoice.qbo_invoice_id})`,
      qboTransactionId: inv.qbo_invoice_id,
      qboTransactionType: "Invoice",
      periodImpact: cpaFlagId ? "cpa_blocked" : "current",
      cpaFlagId,
      decisionOverride: decision,
      aiReasoning: serializeMeta(meta),
      confidenceOverride: dup.confidence,
      toAccountId: dup.surviving_qbo_invoice.qbo_invoice_id,
      toAccountName: dup.surviving_qbo_invoice.doc_number || "survivor",
    });
    proposed++;
  }

  // Surface UF → A/R clearing here too. Bookkeepers expect to clear
  // Undeposited Funds to open invoices from the A/R module, even though the
  // matcher also powers the Undeposited Funds module. proposeUfArMatches
  // skips any payment already staged for this run, so running both modules
  // never double-proposes the same clearing.
  const uf = await proposeUfArMatches(
    service,
    runId,
    clientLinkId,
    periodLockDate,
    "accounts_receivable",
    ufPayments,
    invoices
  );
  proposed += uf.proposed;

  await service
    .from("cleanup_run_modules")
    .update({
      status: "reviewing",
      proposed_count: proposed,
      updated_at: new Date().toISOString(),
    } as any)
    .eq("run_id", runId)
    .eq("module", "accounts_receivable");

  // Best-effort: store the aging tie-out separately so a lagging migration
  // (discovery_notes column not yet applied) can never break discovery.
  if (discoveryNotes) {
    const { error: notesErr } = await service
      .from("cleanup_run_modules")
      .update({ discovery_notes: discoveryNotes } as any)
      .eq("run_id", runId)
      .eq("module", "accounts_receivable");
    if (notesErr) {
      console.warn("[ar-discovery] discovery_notes write failed:", notesErr.message);
    }
  }

  return { proposed, duplicates: duplicates.length };
}
