"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, Edit2, Trash2, Flag, Check, Loader2, Building2, GitMerge, Search } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

type Action = Database["public"]["Tables"]["coa_actions"]["Row"];
type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

interface MasterAccount {
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean;
  section: string | null;
}

export function ReviewClient({
  jobId,
  clientLink,
  initialActions,
  masterAccounts,
}: {
  jobId: string;
  clientLink: ClientLink;
  initialActions: Action[];
  masterAccounts: MasterAccount[];
}) {
  const router = useRouter();
  const [actions, setActions] = useState(initialActions);
  const [filter, setFilter] = useState<"all" | "rename" | "merge" | "delete" | "flag" | "keep" | "create">("all");
  const [executing, setExecuting] = useState(false);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const counts = {
    rename: actions.filter((a) => a.action === "rename").length,
    merge: actions.filter((a) => a.action === "merge").length,
    delete: actions.filter((a) => a.action === "delete").length,
    keep: actions.filter((a) => a.action === "keep").length,
    flag: actions.filter((a) => a.action === "flag").length,
    create: actions.filter((a) => a.action === "create").length,
  };

  const filtered = actions.filter((a) => filter === "all" || a.action === filter);

  async function updateAction(
    actionId: string,
    newAction: Action["action"],
    newTarget?: string
  ) {
    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId
          ? {
              ...a,
              action: newAction,
              new_name: newTarget ?? a.new_name,
              ai_suggested_target: newTarget ?? a.ai_suggested_target,
              bookkeeper_override: true,
            }
          : a
      )
    );

    await supabase
      .from("coa_actions")
      .update({
        action: newAction,
        new_name: newTarget,
        ai_suggested_target: newTarget,
        bookkeeper_override: true,
      })
      .eq("id", actionId);
  }

  async function approveAndExecute() {
    if (!confirm(`Execute this cleanup on ${clientLink.client_name}? This will modify QBO + Double.`)) {
      return;
    }
    setExecuting(true);

    let res: Response;
    let result: any = {};
    try {
      res = await fetch(`/api/jobs/${jobId}/execute`, { method: "POST" });
      result = await res.json().catch(() => ({}));
    } catch (err: any) {
      setExecuting(false);
      alert(`Network error while starting execution: ${err?.message || err}`);
      return;
    }

    setExecuting(false);

    if (res.ok && (result.started || result.message)) {
      router.push(`/jobs/${jobId}/execute`);
    } else {
      const msg =
        result.error ||
        (Array.isArray(result.errors) ? result.errors.join(", ") : null) ||
        `HTTP ${res.status} ${res.statusText}`;
      alert(`Could not start execution: ${msg}`);
    }
  }

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-6 gap-3 mb-5">
        {[
          { label: "Rename", value: counts.rename, color: "#2D7A75" },
          { label: "Merge", value: counts.merge, color: "#7C3AED" },
          { label: "Delete", value: counts.delete, color: "#DC2626" },
          { label: "Keep", value: counts.keep, color: "#475569" },
          { label: "Flagged", value: counts.flag, color: "#F59E0B" },
          { label: "Create New", value: counts.create, color: "#10B981" },
        ].map((s) => (
          <div key={s.label} className="px-4 py-3 rounded-lg bg-white border border-gray-200">
            <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">{s.label}</div>
            <div className="text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {(["all", "rename", "merge", "delete", "flag", "keep", "create"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize ${
              filter === f
                ? "bg-navy text-white border border-navy"
                : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
            }`}
          >
            {f} ({f === "all" ? actions.length : counts[f as keyof typeof counts]})
          </button>
        ))}
      </div>

      {/* Action table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 mb-6">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "1.4fr 1.4fr 1.6fr 0.9fr 1.1fr" }}
        >
          <div>Current Account</div>
          <div>AI Suggestion</div>
          <div>Map to Master</div>
          <div>Confidence</div>
          <div>Action</div>
        </div>

        {filtered.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            masterAccounts={masterAccounts}
            onUpdate={updateAction}
          />
        ))}

        {filtered.length === 0 && (
          <p className="text-sm text-ink-slate py-12 text-center">No actions match this filter.</p>
        )}
      </div>

      <div className="flex justify-between items-center">
        <button
          onClick={() => router.back()}
          className="text-sm font-semibold text-ink-slate hover:text-navy"
        >
          ← Back to Dashboard
        </button>
        <div className="flex gap-3">
          <button className="text-sm font-semibold bg-white text-navy border border-gray-200 px-4 py-2 rounded-lg hover:bg-gray-50">
            Send to Lisa for Approval
          </button>
          <button
            onClick={approveAndExecute}
            disabled={executing}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
          >
            {executing ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            {executing ? "Executing..." : "Approve & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  masterAccounts,
  onUpdate,
}: {
  action: Action;
  masterAccounts: MasterAccount[];
  onUpdate: (id: string, newAction: Action["action"], newTarget?: string) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  const actionConfig: Record<string, { color: string; bg: string; label: string; icon: any }> = {
    keep:   { color: "#475569", bg: "#F1F5F9", label: "Keep",        icon: Check     },
    rename: { color: "#2D7A75", bg: "#E8F2F0", label: "Rename",      icon: Edit2     },
    merge:  { color: "#7C3AED", bg: "#EDE9FE", label: "Merge into",  icon: GitMerge  },
    delete: { color: "#DC2626", bg: "#FEE2E2", label: "Delete",      icon: Trash2    },
    flag:   { color: "#F59E0B", bg: "#FEF3C7", label: "Flag",        icon: Flag      },
    create: { color: "#10B981", bg: "#D1FAE5", label: "Create",      icon: Building2 },
  };
  const cfg = actionConfig[action.action] ?? actionConfig.flag;
  const Icon = cfg.icon;

  const confidencePct = Math.round((action.ai_confidence || 0) * 100);

  // The current mapped target (rename or merge target)
  const currentTarget = action.new_name || action.ai_suggested_target || "";
  const isMappable = action.action === "rename" || action.action === "merge" || action.action === "flag";
  const isDeleteOrKeep = action.action === "delete" || action.action === "keep";

  function handleTargetChange(selectedTarget: string) {
    if (!selectedTarget) return;
    // If it was a flag, promote to rename; merge stays merge; rename stays rename
    const newAction: Action["action"] =
      action.action === "flag" ? "rename"
      : action.action === "merge" ? "merge"
      : "rename";
    onUpdate(action.id, newAction, selectedTarget);
  }

  return (
    <div
      className="grid items-center px-5 py-3.5 hover:bg-teal-lighter transition-colors border-b border-gray-100"
      style={{ gridTemplateColumns: "1.4fr 1.4fr 1.6fr 0.9fr 1.1fr" }}
    >
      {/* Current Account */}
      <div>
        <div className="font-semibold text-sm text-navy">
          {action.current_name || (action.action === "create" ? `(New) ${action.new_name}` : "—")}
        </div>
        {action.current_type && (
          <div className="text-xs mt-0.5 text-ink-slate">{action.current_type}</div>
        )}
      </div>

      {/* AI Suggestion */}
      <div className="text-sm pr-2">
        {action.action === "merge" && action.new_name ? (
          <div className="flex items-center gap-1.5">
            <GitMerge size={13} className="text-purple-600 flex-shrink-0" />
            <span className="font-semibold text-purple-700 text-xs">Merge into {action.new_name}</span>
          </div>
        ) : action.new_name ? (
          <div className="flex items-center gap-1.5">
            <ArrowRight size={13} className="text-teal flex-shrink-0" />
            <span className="font-semibold text-navy">{action.new_name}</span>
          </div>
        ) : null}
        {action.ai_reasoning && (
          <div className="text-xs mt-0.5 italic text-ink-slate leading-tight">{action.ai_reasoning}</div>
        )}
        {action.action === "merge" && action.flagged_reason && (
          <div className="text-xs mt-0.5 text-purple-500 leading-tight">{action.flagged_reason}</div>
        )}
      </div>

      {/* Map to Master dropdown */}
      <div className="pr-3">
        {isDeleteOrKeep || action.action === "create" ? (
          <span className="text-xs text-ink-light italic">—</span>
        ) : (
          <MasterAccountSelect
            value={currentTarget}
            masterAccounts={masterAccounts}
            onChange={handleTargetChange}
            isMerge={action.action === "merge"}
          />
        )}
      </div>

      {/* Confidence */}
      <div>
        <span
          className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold"
          style={{
            color: confidencePct >= 90 ? "#10B981" : confidencePct >= 70 ? "#F59E0B" : "#DC2626",
            backgroundColor: confidencePct >= 90 ? "#D1FAE5" : confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
          }}
        >
          {confidencePct}%
        </span>
      </div>

      {/* Action dropdown */}
      <div className="relative">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-sm font-semibold transition-colors bg-white border border-gray-200 text-navy"
        >
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold"
            style={{ color: cfg.color, backgroundColor: cfg.bg }}
          >
            <Icon size={12} />
            {cfg.label}
          </span>
          <ChevronDown size={14} className="ml-auto text-ink-light" />
        </button>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full mt-1 rounded-lg shadow-lg z-20 overflow-hidden bg-white border border-gray-200 min-w-48">
              {(["keep", "rename", "merge", "delete", "flag"] as const).map((opt) => {
                const optCfg = actionConfig[opt];
                const OptIcon = optCfg.icon;
                const disabled = opt === "delete" && (action.transaction_count || 0) > 0;
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      if (!disabled) {
                        onUpdate(
                          action.id,
                          opt,
                          (opt === "rename" || opt === "merge")
                            ? (action.ai_suggested_target || action.new_name || undefined)
                            : undefined
                        );
                        setShowMenu(false);
                      }
                    }}
                    disabled={disabled}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-teal-lighter disabled:opacity-40 disabled:cursor-not-allowed text-navy"
                  >
                    <OptIcon size={14} />
                    {optCfg.label}
                    {disabled && <span className="text-xs ml-auto text-ink-slate">has txns</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MasterAccountSelect({
  value,
  masterAccounts,
  onChange,
  isMerge,
}: {
  value: string;
  masterAccounts: MasterAccount[];
  onChange: (val: string) => void;
  isMerge: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = masterAccounts.filter((m) =>
    m.account_name.toLowerCase().includes(search.toLowerCase()) ||
    (m.section || "").toLowerCase().includes(search.toLowerCase())
  );

  // Group by section for display
  const grouped: Record<string, MasterAccount[]> = {};
  for (const m of filtered) {
    const sec = m.section || "Other";
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push(m);
  }

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const borderColor = isMerge ? "#7C3AED" : "#2D7A75";
  const displayLabel = value || (isMerge ? "Select merge target…" : "Select master account…");
  const isEmpty = !value;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white hover:bg-gray-50 text-left"
        style={{
          borderColor: isEmpty ? "#D1D5DB" : borderColor,
          color: isEmpty ? "#9CA3AF" : "#0F1F2E",
        }}
      >
        <span className="flex-1 truncate">{displayLabel}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-ink-light" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-72 rounded-lg shadow-xl bg-white border border-gray-200 overflow-hidden">
          {/* Search box */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
            <Search size={13} className="text-ink-light flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts..."
              className="flex-1 text-xs outline-none bg-transparent text-navy placeholder:text-ink-light"
            />
          </div>

          {/* Account list */}
          <div className="max-h-64 overflow-y-auto">
            {Object.keys(grouped).length === 0 ? (
              <div className="px-3 py-4 text-xs text-center text-ink-slate">No matches</div>
            ) : (
              Object.entries(grouped).map(([section, accounts]) => (
                <div key={section}>
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-light bg-gray-50 sticky top-0">
                    {section}
                  </div>
                  {accounts.map((m) => (
                    <button
                      key={m.account_name}
                      onClick={() => {
                        onChange(m.account_name);
                        setOpen(false);
                        setSearch("");
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-teal-lighter transition-colors ${
                        value === m.account_name ? "font-semibold text-teal bg-teal-lighter" : "text-navy"
                      }`}
                    >
                      <span>{m.account_name}</span>
                      {m.parent_account_name && (
                        <span className="ml-1.5 text-ink-light">· {m.parent_account_name}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
