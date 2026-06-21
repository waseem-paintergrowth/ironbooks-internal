"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, CheckCircle2, AlertTriangle, FileText, ArrowRight } from "lucide-react";

/** Human labels for the operational-gate block reasons. */
const REASON_LABELS: Record<string, string> = {
  no_reclass_job: "Transactions for this period aren't categorized yet (no completed reclass covering the month).",
  today_pending: "There are still items pending in the Today queue — clear them first.",
  qbo_token_missing: "QuickBooks isn't connected — reconnect it first.",
  daily_recon_paused: "Daily recon is paused for this client.",
};
const labelFor = (r: string) => REASON_LABELS[r] || r;

type Prep =
  | { status: "ready"; packageId: string; period: string; summary: string | null; recipient: { name: string | null; email: string | null } | null }
  | { status: "not_ready"; period: string; blockReasons: string[]; recipient: any }
  | { status: "sent"; period: string; packageId: string; summary: string | null; recipient: any }
  | { status: "error"; error: string; period?: string };

/**
 * One-click "Close period & send statements" for a production client.
 * Prepare (build + AI summary) → review → confirm → publish to portal + email.
 * The confirm step shows the period + recipient so the send is never ambiguous.
 */
export function CloseAndSendCard({ clientLinkId, clientName }: { clientLinkId: string; clientName: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "preparing" | "review" | "not_ready" | "sending" | "sent" | "error">("idle");
  const [prep, setPrep] = useState<Prep | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    setPhase("preparing"); setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/month-end/prepare`, { method: "POST" });
      const d: Prep = await res.json();
      setPrep(d);
      if (d.status === "sent") setPhase("sent");
      else if (d.status === "not_ready") setPhase("not_ready");
      else if (d.status === "ready") setPhase("review");
      else { setError((d as any).error || "Couldn't prepare statements"); setPhase("error"); }
    } catch (e: any) {
      setError(e?.message || "Network error"); setPhase("error");
    }
  }

  async function send() {
    if (!prep || (prep.status !== "ready")) return;
    const recip = prep.recipient?.name || prep.recipient?.email || "the client";
    if (!confirm(`This will publish ${prep.period} statements to ${clientName}'s portal and email ${recip}. This is client-facing. Send now?`)) return;
    setPhase("sending"); setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/month-end/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package_id: prep.packageId }),
      });
      const d = await res.json();
      if (!res.ok || d.ok === false) { setError(d.error || "Send failed"); setPhase("error"); return; }
      setPhase("sent");
      router.refresh();
    } catch (e: any) {
      setError(e?.message || "Network error"); setPhase("error");
    }
  }

  const recipientLine = (r: any) =>
    r ? `${r.name || r.email}${r.name && r.email ? ` (${r.email})` : ""}` : "the client's portal contact";

  return (
    <section className="rounded-2xl border-2 border-teal/20 bg-gradient-to-br from-teal/5 to-white p-5">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
          <FileText size={20} className="text-teal" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-navy">Close period &amp; send statements</h3>

          {/* IDLE */}
          {phase === "idle" && (
            <>
              <p className="text-sm text-ink-slate mt-1 leading-relaxed">
                When this client's books are clean for the month, prepare their statements — you'll review the summary, then publish to their portal and email them in one step.
              </p>
              <button
                onClick={prepare}
                className="mt-3 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg"
              >
                <FileText size={14} /> Prepare statements
              </button>
            </>
          )}

          {/* PREPARING */}
          {phase === "preparing" && (
            <div className="mt-2 flex items-center gap-2 text-sm text-ink-slate">
              <Loader2 size={15} className="animate-spin text-teal" /> Building the package &amp; summary…
            </div>
          )}

          {/* NOT READY */}
          {phase === "not_ready" && prep?.status === "not_ready" && (
            <div className="mt-2">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
                <AlertTriangle size={15} /> Not ready to send {prep.period} yet
              </div>
              <ul className="mt-2 space-y-1">
                {prep.blockReasons.map((r, i) => (
                  <li key={i} className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">{labelFor(r)}</li>
                ))}
              </ul>
              <button onClick={prepare} className="mt-3 text-xs font-semibold text-teal hover:text-teal-dark">Re-check</button>
            </div>
          )}

          {/* REVIEW → CONFIRM */}
          {phase === "review" && prep?.status === "ready" && (
            <div className="mt-2">
              <div className="text-xs text-ink-slate">
                Period: <strong className="text-navy">{prep.period}</strong> · Will email: <strong className="text-navy">{recipientLine(prep.recipient)}</strong>
              </div>
              <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-ink-light">Summary the client will see — review it</div>
              <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-ink-slate whitespace-pre-wrap leading-relaxed">
                {prep.summary || "(no summary generated)"}
              </div>
              <button
                onClick={send}
                className="mt-3 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg"
              >
                <Send size={14} /> Publish to portal &amp; email client <ArrowRight size={14} />
              </button>
              <p className="mt-1.5 text-[11px] text-ink-light">Publishes {prep.period} to the portal and emails the client that their statements are ready.</p>
            </div>
          )}

          {/* SENDING */}
          {phase === "sending" && (
            <div className="mt-2 flex items-center gap-2 text-sm text-ink-slate">
              <Loader2 size={15} className="animate-spin text-teal" /> Publishing &amp; emailing…
            </div>
          )}

          {/* SENT */}
          {phase === "sent" && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-emerald-900">
                <strong>{(prep as any)?.period || "Statements"} sent.</strong> Published to {clientName}'s portal{(prep as any)?.recipient ? ` and emailed ${recipientLine((prep as any).recipient)}` : ""}.
              </div>
            </div>
          )}

          {/* ERROR */}
          {phase === "error" && (
            <div className="mt-2">
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">{error}</div>
              <button onClick={prepare} className="mt-2 text-xs font-semibold text-teal hover:text-teal-dark">Try again</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
