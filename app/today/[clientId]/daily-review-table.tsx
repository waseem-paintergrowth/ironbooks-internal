"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X, HelpCircle, AlertTriangle, Loader2, Sparkles } from "lucide-react";

interface QueueRow {
  id: string;
  qbo_transaction_id: string;
  qbo_line_id: string;
  vendor_name: string | null;
  transaction_date: string;
  transaction_amount: number | null;
  description: string | null;
  from_account_name: string | null;
  suggested_account_id: string | null;
  suggested_account_name: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  source: string | null;
  anomaly_flags: Array<{ code: string; message: string }> | null;
  decision: string;
  decided_at?: string | null;
  executed_at?: string | null;
}

interface Account {
  id: string;
  name: string;
  type?: string;
}

/**
 * Daily review table — one row per pending QBO line. Approve / Reject / Ask
 * Client per row, plus a dropdown to override the suggested target. Sorted
 * with anomaly-flagged rows first so the bookkeeper triages them up front.
 */
export function DailyReviewTable({
  rows,
  availableAccounts,
  readOnly,
}: {
  rows: QueueRow[];
  availableAccounts: Account[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<{ id: string; msg: string } | null>(null);
  const [overrides, setOverrides] = useState<Map<string, { id: string; name: string }>>(new Map());

  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const af = Array.isArray(a.anomaly_flags) ? a.anomaly_flags.length : 0;
      const bf = Array.isArray(b.anomaly_flags) ? b.anomaly_flags.length : 0;
      if (bf !== af) return bf - af;
      return Math.abs(b.transaction_amount || 0) - Math.abs(a.transaction_amount || 0);
    });
    return arr;
  }, [rows]);

  async function act(row: QueueRow, action: "approve" | "approve_with_override" | "reject" | "ask_client") {
    setBusyId(row.id);
    setErrorId(null);
    try {
      const body: any = { action };
      if (action === "approve_with_override") {
        const o = overrides.get(row.id);
        if (!o) {
          setErrorId({ id: row.id, msg: "Pick a target account first" });
          setBusyId(null);
          return;
        }
        body.target_account_id = o.id;
        body.target_account_name = o.name;
      }
      const res = await fetch(`/api/daily-recon/queue/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErrorId({ id: row.id, msg: d.error || `Failed (${res.status})` });
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch (e: any) {
      setErrorId({ id: row.id, msg: e?.message || "Network error" });
    } finally {
      setBusyId(null);
    }
  }

  function setOverride(rowId: string, accountId: string) {
    const acc = availableAccounts.find((a) => a.id === accountId);
    if (!acc) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(rowId, { id: acc.id, name: acc.name });
      return next;
    });
  }

  if (rows.length === 0) {
    return <div className="p-8 text-center text-ink-slate text-sm">Nothing to show.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Date</th>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Vendor</th>
            <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Amount</th>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">→ AI Target</th>
            {!readOnly && (
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Override</th>
            )}
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Confidence</th>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Source</th>
            {!readOnly && (
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Action</th>
            )}
            {readOnly && (
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Decision</th>
            )}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => {
            const flags = Array.isArray(r.anomaly_flags) ? r.anomaly_flags : [];
            const isBusy = busyId === r.id;
            const err = errorId?.id === r.id ? errorId.msg : null;
            const conf = r.ai_confidence ?? 0;

            return (
              <tr
                key={r.id}
                className={`border-b border-gray-100 ${flags.length > 0 ? "bg-amber-50/40" : "hover:bg-gray-50"}`}
              >
                <td className="px-4 py-2.5 text-ink-slate align-top whitespace-nowrap">
                  {r.transaction_date}
                </td>
                <td className="px-4 py-2.5 align-top">
                  <div className="font-medium text-navy">{r.vendor_name || "(no vendor)"}</div>
                  {r.description && (
                    <div className="text-xs text-ink-slate truncate max-w-xs">{r.description}</div>
                  )}
                  {flags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {flags.map((f, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
                          title={f.message}
                        >
                          <AlertTriangle size={9} />
                          {f.code.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-navy align-top">
                  ${(r.transaction_amount || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td className="px-4 py-2.5 align-top">
                  <div className="text-navy">
                    {r.suggested_account_name || (
                      <span className="text-ink-slate italic">no target</span>
                    )}
                  </div>
                  {r.ai_reasoning && (
                    <div className="text-xs text-ink-slate italic truncate max-w-xs">
                      {r.ai_reasoning}
                    </div>
                  )}
                </td>
                {!readOnly && (
                  <td className="px-4 py-2.5 align-top">
                    {availableAccounts.length > 0 ? (
                      <select
                        value={overrides.get(r.id)?.id || ""}
                        onChange={(e) => setOverride(r.id, e.target.value)}
                        className="text-xs rounded border border-gray-200 px-2 py-1 max-w-xs"
                      >
                        <option value="">— keep AI pick —</option>
                        {availableAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-ink-light">no accounts loaded</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2.5 align-top">
                  <ConfidenceBadge value={conf} />
                </td>
                <td className="px-4 py-2.5 align-top">
                  <SourceBadge source={r.source} />
                </td>
                {!readOnly && (
                  <td className="px-4 py-2.5 align-top">
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex gap-1.5">
                        <button
                          onClick={() =>
                            act(
                              r,
                              overrides.has(r.id) ? "approve_with_override" : "approve"
                            )
                          }
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded hover:bg-emerald-200 disabled:opacity-50"
                          title="Approve and push to QBO"
                        >
                          {isBusy ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <CheckCircle2 size={11} />
                          )}
                          Approve
                        </button>
                        <button
                          onClick={() => act(r, "reject")}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 text-xs rounded hover:bg-red-200 disabled:opacity-50"
                          title="Reject — leaves QBO untouched"
                        >
                          <X size={11} />
                          Reject
                        </button>
                        <button
                          onClick={() => act(r, "ask_client")}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded hover:bg-purple-200 disabled:opacity-50"
                          title="Defer — surface in next client email"
                        >
                          <HelpCircle size={11} />
                          Ask
                        </button>
                      </div>
                      {err && (
                        <span className="text-[11px] text-red-600 font-semibold">{err}</span>
                      )}
                    </div>
                  </td>
                )}
                {readOnly && (
                  <td className="px-4 py-2.5 align-top">
                    <DecisionBadge decision={r.decision} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.95 ? "bg-emerald-100 text-emerald-700"
    : value >= 0.7 ? "bg-amber-100 text-amber-700"
    : "bg-red-100 text-red-700";
  return <span className={`text-xs px-2 py-0.5 rounded ${color} font-semibold`}>{pct}%</span>;
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span className="text-xs text-ink-light">—</span>;
  const labels: Record<string, { label: string; color: string; icon?: React.ReactNode }> = {
    kb: { label: "KB", color: "bg-blue-50 text-blue-700 border-blue-100" },
    bank_rule: { label: "Bank rule", color: "bg-purple-50 text-purple-700 border-purple-100" },
    ai: { label: "AI", color: "bg-teal-lighter text-teal border-teal/20", icon: <Sparkles size={9} /> },
    web_search: { label: "Web", color: "bg-indigo-50 text-indigo-700 border-indigo-100" },
    unmatched: { label: "Unmatched", color: "bg-gray-50 text-ink-slate border-gray-100" },
  };
  const cfg = labels[source] || labels.unmatched;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${cfg.color}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const cfg: Record<string, { label: string; color: string }> = {
    executed: { label: "Executed", color: "bg-emerald-100 text-emerald-700" },
    approved: { label: "Approved", color: "bg-emerald-100 text-emerald-700" },
    auto_approved: { label: "Auto-approved", color: "bg-teal-lighter text-teal" },
    rejected: { label: "Rejected", color: "bg-red-100 text-red-700" },
    ask_client: { label: "Ask client", color: "bg-purple-100 text-purple-700" },
    pending: { label: "Pending", color: "bg-amber-100 text-amber-700" },
  };
  const c = cfg[decision] || cfg.pending;
  return <span className={`text-xs px-2 py-0.5 rounded font-semibold ${c.color}`}>{c.label}</span>;
}
