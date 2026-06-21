"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

interface Candidate {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  method: "email" | "domain" | "name";
  confidence: "high" | "medium" | "low";
}
interface Proposal {
  clientLinkId: string;
  clientName: string;
  best: Candidate | null;
  alternatives: Candidate[];
  recommended: boolean;
  note: string;
}
interface Row extends Proposal {
  checked: boolean;
  cusId: string; // editable / overridable
}

const confTone: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

export function BillingBackfillClient() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ appliedCount: number; failedCount: number; failed: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/billing/backfill-stripe");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setConfigured(data.configured !== false);
      setSummary(data.summary || null);
      setRows(
        (data.proposals || []).map((p: Proposal) => ({
          ...p,
          checked: p.recommended,
          cusId: p.best?.stripeCustomerId || "",
        }))
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function update(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.clientLinkId === id ? { ...r, ...patch } : r)));
  }

  const selected = rows.filter((r) => r.checked && /^cus_[A-Za-z0-9]+$/.test(r.cusId.trim()));

  async function apply() {
    if (selected.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/billing/backfill-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: selected.map((r) => ({ clientLinkId: r.clientLinkId, stripeCustomerId: r.cusId.trim() })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Apply failed");
      setResult(data);
      await load(); // re-pull; applied clients drop off (now linked)
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-slate py-16 justify-center">
        <Loader2 size={16} className="animate-spin text-teal" /> Scanning Stripe for matches…
      </div>
    );
  }
  if (!configured) {
    return <p className="text-sm text-ink-slate italic py-6">Stripe isn't connected (no STRIPE_SECRET_KEY) — can't match customers.</p>;
  }

  return (
    <div className="max-w-4xl space-y-5">
      {summary && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Stat label="Unlinked clients" value={summary.unlinked} />
          <Stat label="Recommended" value={summary.recommended} tone="emerald" />
          <Stat label="Needs review" value={summary.needsReview} tone="amber" />
          <Stat label="No match" value={summary.unmatched} tone="slate" />
          <button onClick={load} className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy">
            <RefreshCw size={13} /> Rescan
          </button>
        </div>
      )}

      {result && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            Linked <strong>{result.appliedCount}</strong> client{result.appliedCount === 1 ? "" : "s"}.
            {result.failedCount > 0 && <span className="text-amber-700"> {result.failedCount} failed — see below.</span>}
          </div>
        </div>
      )}
      {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-2.5 text-xs text-amber-800 flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
        Review each match before applying — only pre-checked rows are unambiguous. Linking the wrong customer would show a client someone else's billing. Paste a <code>cus_…</code> id to override.
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-slate italic">Every active client already has a Stripe customer linked. 🎉</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.clientLinkId} className="px-4 py-3 flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => update(r.clientLinkId, { checked: e.target.checked })}
                  className="mt-1 h-4 w-4 accent-teal flex-shrink-0"
                  aria-label={`Link ${r.clientName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-navy">{r.clientName}</span>
                    {r.best && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confTone[r.best.confidence]}`}>
                        {r.best.confidence} · {r.best.method}
                      </span>
                    )}
                  </div>
                  {r.best ? (
                    <div className="text-xs text-ink-slate mt-0.5">
                      → {r.best.customerName || "(no name)"} {r.best.customerEmail ? `· ${r.best.customerEmail}` : ""}
                    </div>
                  ) : (
                    <div className="text-xs text-ink-light italic mt-0.5">{r.note}</div>
                  )}
                  {r.alternatives.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <span className="text-[10px] text-ink-light">also:</span>
                      {r.alternatives.slice(0, 4).map((alt) => (
                        <button
                          key={alt.stripeCustomerId}
                          onClick={() => update(r.clientLinkId, { cusId: alt.stripeCustomerId, checked: true })}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-ink-slate hover:border-teal hover:text-teal"
                          title={`${alt.method} · ${alt.confidence}`}
                        >
                          {alt.customerName || alt.customerEmail || alt.stripeCustomerId}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  value={r.cusId}
                  onChange={(e) => update(r.clientLinkId, { cusId: e.target.value })}
                  placeholder="cus_…"
                  className="w-40 flex-shrink-0 text-xs font-mono px-2 py-1.5 rounded border border-slate-200 focus:border-teal focus:outline-none"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex items-center gap-3">
          <button
            onClick={apply}
            disabled={selected.length === 0 || applying}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            {applying ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Link {selected.length} selected
          </button>
          <span className="text-xs text-ink-light">Only valid <code>cus_…</code> ids on checked rows are applied.</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const toneCls =
    tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "slate" ? "text-slate-500" : "text-navy";
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-1.5">
      <span className={`text-base font-black ${toneCls}`}>{value ?? 0}</span>
      <span className="text-xs text-ink-slate ml-1.5">{label}</span>
    </div>
  );
}
