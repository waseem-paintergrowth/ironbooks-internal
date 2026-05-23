"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, ArrowRight, AlertTriangle,
  Wallet, CreditCard, FileSpreadsheet, Briefcase, Layers, BookOpen, Landmark,
} from "lucide-react";

interface BsCoaAccount {
  id: string;
  name: string;
  fully_qualified_name: string;
  account_type: string;
  account_subtype: string | null;
  parent_id: string | null;
  parent_name: string | null;
  is_sub_account: boolean;
  current_balance: number;
  currency: string | null;
  active: boolean;
  depth: number;
  children: BsCoaAccount[];
}

interface BsCoaGroup {
  account_type: string;
  accounts: BsCoaAccount[];
  total_balance: number;
}

interface BsCoaResponse {
  ok: boolean;
  client_name: string;
  total_accounts: number;
  active_accounts: number;
  groups: BsCoaGroup[];
}

/**
 * Tree view of every BS account in the client's QBO COA. Read-only for
 * now — edit operations (Phase 3) will mount inline action buttons per
 * row. Each row has a "Reclass transactions" link that routes into the
 * existing scrub-mode reclass for that source account.
 */
export function BsCoaTreeClient({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const [data, setData] = useState<BsCoaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [showInactive, setShowInactive] = useState(false);

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-coa`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body as BsCoaResponse);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-teal" size={28} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm text-red-800">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">Couldn&apos;t load the BS COA</div>
            <div className="text-xs">{error}</div>
            <button
              onClick={fetchData}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-red-900 hover:text-red-700"
            >
              <RefreshCw size={11} /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-xs text-ink-slate">
          <strong className="text-navy">{data.active_accounts}</strong> active
          {data.total_accounts !== data.active_accounts && (
            <span className="text-ink-light">
              {" "}· {data.total_accounts - data.active_accounts} inactive
            </span>
          )}
          {" "}· {data.groups.length} sections
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-slate cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show inactive
        </label>
        <button
          onClick={fetchData}
          className="ml-auto inline-flex items-center gap-1 text-xs text-ink-slate hover:text-navy"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          Refresh from QBO
        </button>
      </div>

      {/* Groups */}
      <div className="space-y-3">
        {data.groups.map((group) => (
          <GroupSection
            key={group.account_type}
            group={group}
            clientLinkId={clientLinkId}
            clientName={clientName}
            showInactive={showInactive}
          />
        ))}
      </div>

      <p className="text-xs text-ink-light leading-relaxed pt-3">
        Tip: click <em>Reclass transactions</em> on any account to dig into
        what&apos;s sitting there. That routes into the scrub reclass workflow
        with this account pre-selected as the source — you can move
        transactions out of Undeposited Funds, clean up A/R aging, etc.
        Edit actions (rename / re-parent / inactivate / add new) will appear
        inline once Phase 3 ships.
      </p>
    </div>
  );
}

function GroupSection({
  group,
  clientLinkId,
  clientName,
  showInactive,
}: {
  group: BsCoaGroup;
  clientLinkId: string;
  clientName: string;
  showInactive: boolean;
}) {
  const [open, setOpen] = useState(true);

  // Count visible accounts in this section
  function visibleCount(node: BsCoaAccount): number {
    let n = node.active || showInactive ? 1 : 0;
    for (const c of node.children) n += visibleCount(c);
    return n;
  }
  const visibleTotal = group.accounts.reduce((s, a) => s + visibleCount(a), 0);
  if (visibleTotal === 0) return null;

  const TypeIcon = iconForType(group.account_type);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        {open ? (
          <ChevronDown size={14} className="text-ink-slate" />
        ) : (
          <ChevronRight size={14} className="text-ink-slate" />
        )}
        <TypeIcon size={16} className="text-teal" />
        <span className="font-bold text-sm text-navy">{group.account_type}</span>
        <span className="text-xs text-ink-slate">({visibleTotal})</span>
        <span className="ml-auto font-mono text-sm text-navy tabular-nums">
          {formatCurrency(group.total_balance)}
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-100">
          {group.accounts.map((acc) => (
            <AccountRow
              key={acc.id}
              account={acc}
              clientLinkId={clientLinkId}
              clientName={clientName}
              showInactive={showInactive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account,
  clientLinkId,
  clientName,
  showInactive,
}: {
  account: BsCoaAccount;
  clientLinkId: string;
  clientName: string;
  showInactive: boolean;
}) {
  if (!account.active && !showInactive) return null;

  // Build reclass URL — pre-fills the scrub form with this account as source
  const reclassHref = `/reclass/new?client=${clientLinkId}&workflow=scrub&source_account_id=${encodeURIComponent(
    account.id
  )}&source_account_name=${encodeURIComponent(account.name)}`;

  const indentPx = account.depth * 18;

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/60 group"
        style={{ paddingLeft: 16 + indentPx }}
      >
        {/* Tree indent marker */}
        {account.depth > 0 && (
          <span className="text-ink-light text-xs leading-none -ml-3 select-none">└</span>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${account.active ? "text-navy" : "text-ink-light line-through"}`}>
              {account.name}
            </span>
            {!account.active && (
              <span className="text-[10px] font-semibold text-ink-light bg-gray-100 px-1.5 py-0.5 rounded">
                inactive
              </span>
            )}
            {account.account_subtype && (
              <span className="text-[10px] text-ink-light">
                · {account.account_subtype}
              </span>
            )}
          </div>
          {account.is_sub_account && account.parent_name && (
            <div className="text-[10px] text-ink-light">
              sub-account of {account.parent_name}
            </div>
          )}
        </div>

        <div className="font-mono text-sm tabular-nums text-navy whitespace-nowrap">
          {formatCurrency(account.current_balance)}
        </div>

        {/* Actions — placeholder for Phase 3, only the reclass link works now */}
        <Link
          href={reclassHref}
          className="inline-flex items-center gap-1 text-xs font-semibold text-teal hover:text-teal-dark opacity-0 group-hover:opacity-100 transition-opacity"
          title={`Open scrub reclass with ${account.name} as the source`}
        >
          Reclass
          <ArrowRight size={11} />
        </Link>
      </div>
      {account.children.map((child) => (
        <AccountRow
          key={child.id}
          account={child}
          clientLinkId={clientLinkId}
          clientName={clientName}
          showInactive={showInactive}
        />
      ))}
    </>
  );
}

function formatCurrency(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function iconForType(type: string) {
  switch (type) {
    case "Bank":
      return Wallet;
    case "Credit Card":
      return CreditCard;
    case "Accounts Receivable":
      return FileSpreadsheet;
    case "Fixed Asset":
    case "Other Asset":
    case "Other Current Asset":
      return Briefcase;
    case "Accounts Payable":
      return FileSpreadsheet;
    case "Other Current Liability":
    case "Long Term Liability":
      return Layers;
    case "Equity":
      return Landmark;
    default:
      return BookOpen;
  }
}
