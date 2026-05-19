"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, CheckCircle2, Search, Sparkles, Database } from "lucide-react";

export function ReclassDiscoveryPending({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("starting");
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState<number>(0);
  const [webSearchLog, setWebSearchLog] = useState<string[]>([]);

  // Tick the elapsed-time counter (so user sees something moving)
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/reclass/${jobId}/status`);
        if (!res.ok) throw new Error("Status check failed");
        const data = await res.json();
        if (cancelled) return;

        setStatus(data.status);
        setStats(data.stats);

        // Capture web search progress written to error_message during execution
        if (data.error_message?.startsWith("[web_search]")) {
          setWebSearchLog((prev) => {
            const entry = `${new Date().toLocaleTimeString()} ${data.error_message}`;
            return prev.includes(entry) ? prev : [...prev, entry];
          });
        }

        if (data.status === "in_review") {
          window.location.reload();
          return;
        }
        if (data.status === "failed") {
          setError(data.error_message || "Discovery failed");
          return;
        }
        if (data.status === "complete") {
          window.location.href = `/reclass/${jobId}/execute`;
          return;
        }

        // Continue polling
        setTimeout(poll, 2000);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId, router]);

  if (error) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8">
        <div className="flex items-start gap-3 p-4 bg-red-50 text-red-800 rounded-lg">
          <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
          <div>
            <div className="font-semibold mb-1">Discovery failed</div>
            <div className="text-sm">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  // Derive which stage we're in from elapsed time as a fallback (job status doesn't
  // tick through stages — it's executing until done). Give the user a sense of progress.
  const stage =
    elapsed < 5 ? "pulling"
    : elapsed < 15 ? "knowledge_base"
    : elapsed < 45 ? "ai"
    : "web_search";

  function StageRow({
    icon: Icon, label, hint, active, done,
  }: { icon: any; label: string; hint: string; active: boolean; done: boolean }) {
    return (
      <div className="flex items-start gap-3 py-2.5">
        <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
          style={{
            backgroundColor: done ? "#D1FAE5" : active ? "#E8F2F0" : "#F3F4F6",
          }}
        >
          {done ? (
            <CheckCircle2 size={16} className="text-green-600" />
          ) : active ? (
            <Loader2 size={14} className="text-teal animate-spin" />
          ) : (
            <Icon size={14} className="text-ink-light" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold ${active ? "text-navy" : done ? "text-green-700" : "text-ink-light"}`}>
            {label}
          </div>
          <div className="text-xs text-ink-slate mt-0.5">{hint}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 className="animate-spin text-teal" size={24} />
        <h2 className="text-lg font-bold text-navy">Discovery in progress</h2>
        <span className="ml-auto text-xs font-mono text-ink-slate">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
      </div>
      <p className="text-sm text-ink-slate mb-6">
        Each transaction goes through a 4-tier categorization pipeline. Most match instantly from
        the knowledge base or your saved bank rules; only the unknowns hit the AI or web search.
      </p>

      {/* Pipeline stages */}
      <div className="rounded-xl bg-gray-50 p-4 mb-5 border border-gray-100">
        <StageRow
          icon={Database}
          label="1. Pull transactions from QuickBooks"
          hint="Fetching all lines in the selected date range"
          active={stage === "pulling"}
          done={stage !== "pulling"}
        />
        <StageRow
          icon={Database}
          label="2. Knowledge base + bank rules pre-match"
          hint="Instant matches for ~200 known vendors + your prior categorizations"
          active={stage === "knowledge_base"}
          done={stage !== "pulling" && stage !== "knowledge_base"}
        />
        <StageRow
          icon={Sparkles}
          label="3. AI categorization (Claude)"
          hint="Batched call for unknown vendors"
          active={stage === "ai"}
          done={stage === "web_search"}
        />
        <StageRow
          icon={Search}
          label="4. Web search for low-confidence vendors"
          hint="One search per unique unknown vendor — results cached for next time"
          active={stage === "web_search"}
          done={false}
        />
      </div>

      {/* Live web search log — only shown once stage 4 is active */}
      {(stage === "web_search" || webSearchLog.length > 0) && (
        <div className="rounded-lg overflow-hidden border border-gray-200 mb-5">
          <div className="bg-gray-900 px-3 py-2 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
            </div>
            <span className="text-xs text-gray-400 font-mono ml-1">web_search.log</span>
            {stage === "web_search" && (
              <Loader2 size={11} className="ml-auto text-teal animate-spin" />
            )}
          </div>
          <div className="bg-gray-950 px-4 py-3 font-mono text-xs text-green-400 min-h-[60px] max-h-[180px] overflow-y-auto space-y-1">
            {webSearchLog.length === 0 ? (
              <span className="text-gray-500">Waiting for first batch...</span>
            ) : (
              webSearchLog.map((line, i) => (
                <div key={i} className="leading-relaxed">
                  <span className="text-gray-500">{line.split(" ").slice(0, 2).join(" ")} </span>
                  <span>{line.split(" ").slice(2).join(" ")}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="space-y-2 text-sm">
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Transactions pulled</span>
          <span className="font-semibold text-navy">{stats?.pulled || "..."}</span>
        </div>
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Skipped (reconciled)</span>
          <span className="font-semibold text-navy">{stats?.skipped_reconciled || 0}</span>
        </div>
        <div className="flex justify-between py-2">
          <span className="text-ink-slate">Skipped (closed period)</span>
          <span className="font-semibold text-navy">{stats?.skipped_closed || 0}</span>
        </div>
      </div>

      <p className="text-xs text-ink-light text-center mt-5">
        Total time: usually 30-60s for the AI step + ~2s per unique unknown vendor for web search.
        Page auto-refreshes when done.
      </p>
    </div>
  );
}
