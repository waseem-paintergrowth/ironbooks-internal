"use client";

import { useState } from "react";
import { Loader2, BarChart3, CheckCircle2, PlayCircle, ArrowRight } from "lucide-react";

/**
 * MonthlyBsCheckButton — per-client monthly close trigger on /today.
 *
 * Three states based on the server-fetched `monthlyCloseStatus`:
 *
 *   "closed"      → emerald "Closed for <period> ✓" pill. Click jumps
 *                   into the completed run for read-only review.
 *   "in_progress" → amber "Resume close" pill with the run_id pre-resolved.
 *                   Click → straight to the wizard (no API round-trip).
 *   "not_started" → teal "Start close" CTA. Click → POST /api/cleanup/monthly
 *                   (existing endpoint, returns either new run_id or the
 *                   existing in-progress one via checkActiveRun).
 *
 * The server (app/today/page.tsx) computes status by looking for a
 * cleanup_runs row with workflow_mode=monthly_close + period_lock_date
 * inside the current closing period.
 */
interface Props {
  clientLinkId: string;
  monthlyCloseStatus?: "closed" | "in_progress" | "not_started";
  existingRunId?: string | null;
  periodLabel?: string;
}

export function MonthlyBsCheckButton({
  clientLinkId,
  monthlyCloseStatus = "not_started",
  existingRunId = null,
  periodLabel,
}: Props) {
  const [loading, setLoading] = useState(false);

  async function start(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    try {
      const res = await fetch("/api/cleanup/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.href = `/balance-sheet/${clientLinkId}/cleanup/${data.run_id}`;
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openExisting(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!existingRunId) return;
    window.location.href = `/balance-sheet/${clientLinkId}/cleanup/${existingRunId}`;
  }

  // ── Closed for the current period — emerald success state
  if (monthlyCloseStatus === "closed" && existingRunId) {
    return (
      <button
        onClick={openExisting}
        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
        title={periodLabel ? `Closed for ${periodLabel} — click to open run` : "Closed — click to open run"}
      >
        <CheckCircle2 size={10} />
        Closed{periodLabel ? ` for ${periodLabel}` : ""}
      </button>
    );
  }

  // ── In progress — amber resume state
  if (monthlyCloseStatus === "in_progress" && existingRunId) {
    return (
      <button
        onClick={openExisting}
        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
        title={periodLabel ? `Monthly close in progress for ${periodLabel}` : "Monthly close in progress"}
      >
        <PlayCircle size={10} />
        Resume close
        <ArrowRight size={9} />
      </button>
    );
  }

  // ── Not started — teal start CTA (also the original behavior)
  return (
    <button
      onClick={start}
      disabled={loading}
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded border border-teal/30 text-teal hover:bg-teal/5 disabled:opacity-50"
      title={periodLabel ? `Start monthly close for ${periodLabel}` : "Start monthly close"}
    >
      {loading ? <Loader2 size={10} className="animate-spin" /> : <BarChart3 size={10} />}
      Start close
    </button>
  );
}
