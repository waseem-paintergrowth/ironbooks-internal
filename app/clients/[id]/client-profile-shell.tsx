"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Activity,
  FileText,
  Scale,
  Banknote,
  ExternalLink,
  Loader2,
  ChevronRight,
  Settings as SettingsIcon,
  Clock,
} from "lucide-react";
import type {
  OutstandingWork,
  ActivityEvent,
  InternalSummary,
} from "@/lib/internal-client-profile";
import type { OverviewData, BalanceSheetSummary } from "@/lib/portal-data";

type ClientLink = {
  id: string;
  client_name: string;
  qbo_realm_id: string | null;
  industry: string | null;
  jurisdiction: string | null;
  state_province: string | null;
  status: string | null;
  last_synced_at: string | null;
};

interface OverviewBundle {
  outstanding: OutstandingWork | null;
  activity: ActivityEvent[];
  summary: InternalSummary | null;
}

interface FinancialsBundle {
  /** Combined P&L (primary + comparison), banks, A/R, A/P. */
  overview: OverviewData | null;
  balanceSheet: BalanceSheetSummary | null;
  primaryRangeLabel: string;
  comparisonRangeLabel: string;
  /** False when the client hasn't connected QBO yet — financial tabs
   *  render an empty-state instead of pretending zeros. */
  hasQbo: boolean;
}

interface Props {
  clientLink: ClientLink;
  actorRole: string;
  overview: OverviewBundle;
  financials: FinancialsBundle;
}

type TabId = "overview" | "pl" | "bs" | "bank" | "activity";

const TABS: { id: TabId; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "pl", label: "P&L", icon: FileText },
  { id: "bs", label: "Balance Sheet", icon: Scale },
  { id: "bank", label: "Bank Balances", icon: Banknote },
  { id: "activity", label: "Activity", icon: Clock },
];

export function ClientProfileShell({ clientLink, actorRole, overview, financials }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const canImpersonate = actorRole === "admin" || actorRole === "lead";

  return (
    <div className="px-8 py-6 max-w-7xl mx-auto space-y-6">
      {/* Top action bar — sits above the tab strip so the actions are visible
          from every tab without having to scroll back. "View as client" is
          the most-requested handoff so it gets the most-prominent slot. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-ink-slate">
          {clientLink.last_synced_at && (
            <span className="text-xs">
              Last QBO sync:{" "}
              {new Date(clientLink.last_synced_at).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canImpersonate && <ViewAsClientButton clientLinkId={clientLink.id} />}
          <Link
            href={`/clients/${clientLink.id}/match-double`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-gray-300 bg-white px-3 py-2 rounded-lg transition-colors"
          >
            <SettingsIcon size={14} />
            Match to Double
          </Link>
        </div>
      </div>

      {/* Tab strip — top-level navigation between financial views. Tabs are
          stateful (no URL change) so we keep page state per tab without
          shuffling the address bar; switch to nested routes later if we
          want deep-link-per-tab. */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && (
        <OverviewTab clientLink={clientLink} overview={overview} />
      )}
      {activeTab === "pl" && <PLTab financials={financials} clientLinkId={clientLink.id} />}
      {activeTab === "bs" && <BSTab financials={financials} clientLinkId={clientLink.id} />}
      {activeTab === "bank" && <BankTab financials={financials} clientLinkId={clientLink.id} />}
      {activeTab === "activity" && (
        <ActivityTab activity={overview.activity} />
      )}
    </div>
  );
}

// ─── OVERVIEW TAB ──────────────────────────────────────────────────────

function OverviewTab({
  clientLink,
  overview,
}: {
  clientLink: ClientLink;
  overview: OverviewBundle;
}) {
  const { outstanding, summary, activity } = overview;

  return (
    <div className="space-y-6">
      {/* Outstanding work — top-priority card. If empty we show a positive
          "all clear" state because seeing "0 outstanding items" hidden in
          a corner feels less reassuring than a deliberate empty state. */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-navy">Outstanding work</h2>
          {outstanding && outstanding.totalCount > 0 && (
            <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
              {outstanding.totalCount} item{outstanding.totalCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {outstanding && outstanding.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {outstanding.items.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="group flex items-start gap-3 bg-white border border-gray-200 hover:border-amber-300 hover:shadow-sm rounded-xl p-4 transition-all"
              >
                <div className="shrink-0 mt-0.5">
                  <AlertCircle
                    size={18}
                    className={
                      item.category.includes("failed")
                        ? "text-red-500"
                        : "text-amber-500"
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-navy group-hover:text-teal">
                    {item.label}
                  </div>
                  <div className="text-xs text-ink-slate mt-0.5 truncate">
                    {item.detail}
                  </div>
                  {item.occurredAt && (
                    <div className="text-[10px] text-ink-slate/70 mt-1">
                      {new Date(item.occurredAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-ink-slate group-hover:text-teal mt-0.5"
                />
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800">
            ✓ Nothing outstanding — this client is up to date.
          </div>
        )}
      </section>

      {/* SNAP-side summary stats — bank rules + recent jobs. Quick numeric
          glance that complements the outstanding-work cards above. */}
      {summary && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">SNAP status</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard
              label="Active bank rules"
              value={summary.activeBankRules}
              subtext={
                summary.lastRuleExportAt
                  ? `Last exported ${new Date(summary.lastRuleExportAt).toLocaleDateString()}`
                  : "Never exported to QBO"
              }
            />
            <StatCard
              label="Recent reclass jobs"
              value={summary.recentReclassJobs.length}
              subtext={
                summary.recentReclassJobs[0]
                  ? `Latest: ${summary.recentReclassJobs[0].status}`
                  : "No reclass jobs yet"
              }
            />
            <StatCard
              label="Recent BS cleanups"
              value={summary.recentCleanups.length}
              subtext={
                summary.recentCleanups[0]
                  ? `Latest: ${summary.recentCleanups[0].status}`
                  : "No cleanups yet"
              }
            />
          </div>
          {summary.recentReclassJobs.length > 0 && (
            <div className="mt-4 bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {summary.recentReclassJobs.map((j) => (
                <Link
                  key={j.id}
                  href={`/reclass/${j.id}/review`}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-teal-lighter/50 transition-colors"
                >
                  <div className="text-sm">
                    <span className="font-semibold text-navy">
                      {j.workflow || "reclass"}
                    </span>
                    <span className="text-ink-slate mx-2">·</span>
                    <span className="text-ink-slate">
                      {j.sourceAccountName || "all accounts"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={j.status} />
                    <span className="text-xs text-ink-slate">
                      {new Date(j.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Recent activity strip — last 10 events from audit_log */}
      {activity.length > 0 && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">Recent activity</h2>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {activity.slice(0, 10).map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between px-4 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Activity size={13} className="text-ink-slate shrink-0" />
                  <span className="text-sm text-navy truncate">{e.label}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-ink-slate">
                    {new Date(e.occurredAt).toLocaleString()}
                  </span>
                  {e.href && (
                    <Link
                      href={e.href}
                      className="text-xs font-semibold text-teal hover:text-teal-dark"
                    >
                      View →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── ACTIVITY TAB ──────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-ink-slate">
        No recent SNAP activity logged for this client.
      </div>
    );
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
      {activity.map((e) => (
        <div
          key={e.id}
          className="flex items-start justify-between px-5 py-3 hover:bg-teal-lighter/30"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-navy">{e.label}</div>
            <div className="text-[11px] text-ink-slate mt-0.5 font-mono">
              {e.eventType}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <span className="text-xs text-ink-slate">
              {new Date(e.occurredAt).toLocaleString()}
            </span>
            {e.href && (
              <Link
                href={e.href}
                className="text-xs font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
              >
                View <ExternalLink size={11} />
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── FINANCIAL TABS ────────────────────────────────────────────────────

function NoQboState({ clientLinkId }: { clientLinkId: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
      <div className="text-sm font-semibold text-navy mb-1">
        QuickBooks not connected
      </div>
      <div className="text-xs text-ink-slate mb-3">
        Financial reports need a live QBO connection for this client.
      </div>
      <Link
        href={`/clients/${clientLinkId}/match-double`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark"
      >
        Configure client settings →
      </Link>
    </div>
  );
}

function PLTab({
  financials,
  clientLinkId,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch P&amp;L from QuickBooks. The QBO connection might have expired —
        check the client settings and try again.
      </div>
    );
  }

  const pl = financials.overview.primaryPL;
  const prev = financials.overview.comparisonPL;
  const incomeDelta = pl.totalIncome - prev.totalIncome;
  const expensesDelta = pl.totalExpenses - prev.totalExpenses;
  const niDelta = pl.netIncome - prev.netIncome;

  // Sort line items by absolute size so the biggest movers are at the top.
  // Bookkeepers reviewing a P&L want to spot anomalies fast — alphabetical
  // by account name buries the lead.
  const sortedLines = [...pl.lineItems].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount)
  );

  return (
    <div className="space-y-4">
      <div className="text-xs text-ink-slate">
        Range: <span className="font-semibold text-navy">{financials.primaryRangeLabel}</span>
        {" "}vs prior period {financials.comparisonRangeLabel}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total income" value={pl.totalIncome} delta={incomeDelta} />
        <KPICard label="Total expenses" value={pl.totalExpenses} delta={expensesDelta} invertDeltaColor />
        <KPICard label="Net income" value={pl.netIncome} delta={niDelta} />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
          P&amp;L detail · biggest lines first
        </div>
        <div className="divide-y divide-gray-100">
          {sortedLines.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-slate text-center">
              No P&amp;L activity in this period.
            </div>
          ) : (
            sortedLines.map((line, i) => (
              <div
                key={`${line.label}-${i}`}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <div className="text-navy truncate pr-2">
                  {line.label}
                  <span className="text-[10px] text-ink-slate ml-2 font-normal">{line.group}</span>
                </div>
                <div
                  className={`font-mono font-semibold shrink-0 ${
                    line.amount < 0 ? "text-red-600" : "text-navy"
                  }`}
                >
                  {formatCurrency(line.amount)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function BSTab({
  financials,
  clientLinkId,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.balanceSheet) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch the Balance Sheet from QuickBooks.
      </div>
    );
  }

  const bs = financials.balanceSheet;
  // Group by Classification + sort by absolute balance. Internal users
  // see ALL active accounts, not just top-5 like the portal — they need
  // the full picture for cleanup decisions.
  const groups: Record<"Asset" | "Liability" | "Equity", Array<{ name: string; balance: number }>> = {
    Asset: [],
    Liability: [],
    Equity: [],
  };
  for (const acct of bs.accounts) {
    const bal = bs.balances.get(acct.Id) ?? 0;
    if (Math.abs(bal) < 0.01) continue;
    const g = acct.Classification as keyof typeof groups;
    if (g in groups) groups[g].push({ name: acct.Name, balance: bal });
  }
  for (const k of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-ink-slate">
        <div>
          As of <span className="font-semibold text-navy">{bs.asOfDate}</span>
        </div>
        <Link
          href={`/balance-sheet/${clientLinkId}`}
          className="font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
        >
          Open full BS workspace <ExternalLink size={11} />
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total assets" value={bs.totalAssets} />
        <KPICard label="Total liabilities" value={bs.totalLiabilities} />
        <KPICard label="Total equity" value={bs.totalEquity} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(["Asset", "Liability", "Equity"] as const).map((g) => (
          <BSGroup key={g} title={g} rows={groups[g]} />
        ))}
      </div>
    </div>
  );
}

function BSGroup({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ name: string; balance: number }>;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
        {title}
      </div>
      <div className="divide-y divide-gray-100 max-h-96 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-xs text-ink-slate text-center">No {title.toLowerCase()} balances</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-4 py-2 text-sm"
            >
              <div className="text-navy truncate pr-2" title={r.name}>{r.name}</div>
              <div
                className={`font-mono font-semibold shrink-0 ${
                  r.balance < 0 ? "text-red-600" : "text-navy"
                }`}
              >
                {formatCurrency(r.balance)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BankTab({
  financials,
  clientLinkId,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch bank balances.
      </div>
    );
  }
  const banks = financials.overview.banks;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total cash" value={banks.totalCashOnHand} />
        <KPICard label="Credit card debt" value={banks.totalCreditCardDebt} invertDeltaColor />
        <KPICard
          label="Net liquidity"
          value={banks.totalCashOnHand - banks.totalCreditCardDebt}
        />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
          Bank accounts &amp; credit cards
        </div>
        <div className="divide-y divide-gray-100">
          {banks.accounts.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-slate text-center">
              No bank or credit card accounts found in QBO.
            </div>
          ) : (
            banks.accounts.map((a, i) => (
              <div
                key={`${a.name}-${i}`}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <div>
                  <div className="text-navy font-semibold">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.type}</div>
                </div>
                <div
                  className={`font-mono font-bold ${
                    a.balance < 0 ? "text-red-600" : "text-navy"
                  }`}
                >
                  {formatCurrency(a.balance)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── UI BITS ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: number | string;
  subtext?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div className="text-2xl font-bold text-navy mt-1">{value}</div>
      {subtext && (
        <div className="text-[11px] text-ink-slate mt-1">{subtext}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete: "bg-emerald-50 text-emerald-700",
    in_review: "bg-amber-50 text-amber-700",
    executing: "bg-blue-50 text-blue-700",
    failed: "bg-red-50 text-red-700",
    web_search_paused: "bg-purple-50 text-purple-700",
  };
  const className = styles[status] || "bg-gray-100 text-ink-slate";
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${className}`}>
      {status}
    </span>
  );
}

function KPICard({
  label,
  value,
  delta,
  invertDeltaColor,
}: {
  label: string;
  value: number;
  delta?: number;
  /** Treat "value went up" as bad (e.g. expenses, credit card debt). */
  invertDeltaColor?: boolean;
}) {
  const hasDelta = typeof delta === "number" && Math.abs(delta) > 0.005;
  const deltaIsBad = hasDelta
    ? invertDeltaColor
      ? delta! > 0
      : delta! < 0
    : false;
  const deltaIsGood = hasDelta && !deltaIsBad;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div
        className={`text-2xl font-bold mt-1 font-mono ${
          value < 0 ? "text-red-600" : "text-navy"
        }`}
      >
        {formatCurrency(value)}
      </div>
      {hasDelta && (
        <div
          className={`text-[11px] mt-1 font-semibold ${
            deltaIsGood ? "text-emerald-700" : deltaIsBad ? "text-red-600" : "text-ink-slate"
          }`}
        >
          {delta! > 0 ? "▲" : "▼"} {formatCurrency(Math.abs(delta!))} vs prior period
        </div>
      )}
    </div>
  );
}

function formatCurrency(n: number): string {
  // Compact format for the dashboard. Doesn't need to be exact-cent precision
  // — bookkeepers can drill into the underlying reports for that.
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ViewAsClientButton({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleViewAs() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to start impersonation");
        setLoading(false);
        return;
      }
      // Open the portal in a new tab so the bookkeeper doesn't lose the
      // internal context they were just looking at.
      window.open(data.redirect || "/portal", "_blank");
    } catch (e: any) {
      alert(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleViewAs}
      disabled={loading}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/40 hover:border-teal bg-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
      title="Open this client's portal in a new tab as if you were them — for QA, screenshots, or debugging what they see"
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
      View as client
    </button>
  );
}
