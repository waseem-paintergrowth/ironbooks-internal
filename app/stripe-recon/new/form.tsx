"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, AlertCircle, Calendar, CreditCard, ArrowRight,
} from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
}

interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

export function NewStripeReconForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [clientLinkId, setClientLinkId] = useState<string>("");
  const [reclassJobId, setReclassJobId] = useState<string | null>(null);

  const [datePresetId, setDatePresetId] = useState<string>("fy");
  const [datePresets, setDatePresets] = useState<DateRangePreset[]>([]);
  const [fiscalYearStartMonthName, setFiscalYearStartMonthName] = useState<string>("");
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [presetsError, setPresetsError] = useState<string>("");

  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>("");

  const selectedClient = clientLinks.find((c) => c.id === clientLinkId);

  // Auto-init from query string (handoff from reclass)
  useEffect(() => {
    const cId = searchParams.get("client");
    const rId = searchParams.get("reclass_job_id");
    if (cId && clientLinks.some((c) => c.id === cId)) setClientLinkId(cId);
    if (rId) setReclassJobId(rId);
  }, [searchParams, clientLinks]);

  // Load fiscal year + presets when client is selected
  useEffect(() => {
    if (!clientLinkId) return;
    setLoadingPresets(true);
    setPresetsError("");
    fetch(`/api/clients/${clientLinkId}/company-info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load company info");
        return r.json();
      })
      .then((data) => {
        setDatePresets(data.date_range_presets);
        setFiscalYearStartMonthName(data.company.fiscal_year_start_month_name);
        const def = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy")
                 || data.date_range_presets[0];
        if (def) {
          setDatePresetId(def.id);
          setDateRangeStart(def.start);
          setDateRangeEnd(def.end);
        }
      })
      .catch((e) => setPresetsError(e.message))
      .finally(() => setLoadingPresets(false));
  }, [clientLinkId]);

  useEffect(() => {
    const p = datePresets.find((p) => p.id === datePresetId);
    if (p) { setDateRangeStart(p.start); setDateRangeEnd(p.end); }
  }, [datePresetId, datePresets]);

  const canSubmit =
    !!clientLinkId && !!dateRangeStart && !!dateRangeEnd && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !selectedClient) return;
    setSubmitting(true);
    setSubmitError("");

    try {
      const res = await fetch("/api/stripe-recon/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          reclass_job_id: reclassJobId || undefined,
          date_range_start: dateRangeStart,
          date_range_end: dateRangeEnd,
          jurisdiction: selectedClient.jurisdiction,
          state_province: selectedClient.state_province || "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start job");
      router.push(`/stripe-recon/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
        <div className="flex items-center gap-3">
          <CreditCard className="text-teal" size={24} />
          <h2 className="text-lg font-bold text-navy">Stripe AR Reconciliation</h2>
        </div>

        <p className="text-sm text-ink-slate">
          Pull Stripe deposits in a date range. AI matches each deposit to the customer
          invoices that make it up, calculates the Stripe processing fee
          {" "}(and sales tax on the fee for Canadian clients), and writes it back as
          labeled line items.
        </p>

        {reclassJobId && (
          <div className="p-3 rounded-lg bg-teal-lighter border border-teal/30 text-xs text-navy">
            ↪ Continuing from a transaction reclassification job.
          </div>
        )}

        {/* Client */}
        <div>
          <label className="block text-sm font-semibold text-navy mb-2">Client</label>
          <select
            value={clientLinkId}
            onChange={(e) => setClientLinkId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
          >
            <option value="">Select a client...</option>
            {clientLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name} ({c.jurisdiction}{c.state_province ? ` · ${c.state_province}` : ""})
              </option>
            ))}
          </select>
        </div>

        {clientLinkId && (
          <>
            {loadingPresets && (
              <div className="flex items-center gap-2 text-sm text-ink-slate">
                <Loader2 className="animate-spin" size={16} />
                Loading fiscal year from QuickBooks...
              </div>
            )}
            {presetsError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {presetsError}
              </div>
            )}

            {datePresets.length > 0 && (
              <div>
                <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
                  <Calendar size={14} /> Date Range
                </label>
                <div className="text-xs text-ink-slate mb-2">
                  Fiscal year starts in <span className="font-semibold">{fiscalYearStartMonthName}</span> (pulled from QBO)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {datePresets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setDatePresetId(p.id)}
                      className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold text-left transition-colors ${
                        datePresetId === p.id
                          ? "bg-teal-lighter border-teal text-teal"
                          : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                      }`}
                    >
                      <div>{p.label}</div>
                      <div className="text-[10px] text-ink-light mt-0.5 font-normal">
                        {p.start} → {p.end}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {submitError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        {clientLinkId && (
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
            {submitting ? "Starting discovery..." : "Find Stripe deposits & match"}
          </button>
        )}
      </div>
    </div>
  );
}
