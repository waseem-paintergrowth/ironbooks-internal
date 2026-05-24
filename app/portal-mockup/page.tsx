/**
 * Portal Overview (landing page) — mockup.
 *
 * The "first 30 seconds" experience. Client lands here after login and
 * sees a layman-language summary of their business health. No accounting
 * jargon. Big numbers, plain English, "what does this mean" tooltips.
 *
 * Real version pulls from QBO + a Claude-generated weekly narrative.
 */
import Link from "next/link";
import {
  TrendingUp, TrendingDown, AlertCircle, MessageSquare, ArrowRight,
  DollarSign, Receipt, Wallet, Sparkles,
} from "lucide-react";

export default function PortalOverview() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Good afternoon</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Here's how your business is doing</h1>
        <div className="text-sm text-ink-slate mt-1">As of May 24, 2026 · Updated daily from QuickBooks</div>
      </div>

      {/* The big health summary — Claude-generated in the real version */}
      <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-6">
        <div className="flex items-start gap-3 mb-3">
          <Sparkles size={20} className="text-teal-dark mt-0.5" />
          <div className="flex-1">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">This month at a glance</div>
            <h2 className="text-lg font-bold text-navy mt-1">You're up $18,400 vs last month — best May ever.</h2>
          </div>
        </div>
        <p className="text-sm text-navy/80 leading-relaxed">
          You brought in <strong>$84,200</strong> from painting jobs in May. That's <strong>27% more</strong> than April,
          mostly driven by three big commercial jobs that closed mid-month. Your costs went up too
          (more paint, more subcontractors), but profit grew faster — you kept <strong>$22,100</strong> of
          every dollar you earned, which is healthy for a painting business your size.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Link
            href="/portal-mockup/ask-ai"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
          >
            <MessageSquare size={12} />
            Ask the AI to explain more
          </Link>
        </div>
      </div>

      {/* Three KPI tiles in plain language */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard
          icon={DollarSign}
          label="Money in this month"
          value="$84,200"
          delta="+$18,400 vs April"
          deltaPositive
          tooltip="Total payments and invoices for work you did or jobs you completed in May."
        />
        <KpiCard
          icon={Receipt}
          label="Costs this month"
          value="$62,100"
          delta="+$8,200 vs April"
          deltaPositive={false}
          tooltip="Everything you spent — materials, subs, payroll, overhead. Higher costs aren't always bad when revenue grows faster."
        />
        <KpiCard
          icon={Wallet}
          label="What's left (profit)"
          value="$22,100"
          delta="+$10,200 vs April"
          deltaPositive
          tooltip="Money in minus costs. This is what's truly yours — what you can save, reinvest, or take home."
        />
      </div>

      {/* What needs your attention */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-navy">What needs your attention</h3>
          <span className="text-xs text-ink-slate">3 items</span>
        </div>
        <div className="space-y-3">
          <AttentionItem
            color="red"
            icon={AlertCircle}
            title="$8,400 overdue from Hudson Construction"
            body="Invoice INV-1042 is 47 days past due. We've reminded them twice. Want to call?"
            cta="See all overdue"
            href="/portal-mockup/whos-paying"
          />
          <AttentionItem
            color="amber"
            icon={Receipt}
            title="Quarterly taxes due in 11 days"
            body="$4,200 owed to the IRS for Q1. Make sure your business checking has at least $5K available by June 4."
            cta="Got it"
          />
          <AttentionItem
            color="teal"
            icon={TrendingUp}
            title="Material costs are up 12% — worth a look"
            body="You're paying more for paint at Sherwin-Williams vs your historical average. Could be a price hike or a different product mix."
            cta="Ask the AI why"
            href="/portal-mockup/ask-ai"
          />
        </div>
      </div>

      {/* Cash on hand strip */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <h3 className="font-bold text-navy mb-3">Cash on hand</h3>
        <div className="grid grid-cols-3 gap-4">
          <CashTile label="Operating checking" amount="$42,150" sub="Chase XX84" />
          <CashTile label="Savings" amount="$28,900" sub="Chase XX20" />
          <CashTile label="Credit card balance" amount="-$6,240" sub="Amex 62009" negative />
        </div>
        <div className="mt-3 text-xs text-ink-slate">
          Total available: <strong className="text-navy">$64,810</strong>{" "}
          (about <strong>3.1 months</strong> of typical expenses — that's a healthy cushion)
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon, label, value, delta, deltaPositive, tooltip,
}: { icon: any; label: string; value: string; delta: string; deltaPositive: boolean; tooltip: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className="text-ink-slate" />
        <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-navy mt-2">{value}</div>
      <div className={`text-xs mt-1 ${deltaPositive ? "text-emerald-700" : "text-amber-700"}`}>
        {deltaPositive ? <TrendingUp size={11} className="inline mr-0.5" /> : <TrendingDown size={11} className="inline mr-0.5" />}
        {delta}
      </div>
      <div className="mt-3 text-[11px] text-ink-light italic leading-relaxed">{tooltip}</div>
    </div>
  );
}

function AttentionItem({
  color, icon: Icon, title, body, cta, href,
}: { color: "red" | "amber" | "teal"; icon: any; title: string; body: string; cta: string; href?: string }) {
  const colors = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    teal: "bg-teal/5 border-teal/30 text-teal-dark",
  }[color];
  return (
    <div className={`flex items-start gap-3 p-3 border rounded-lg ${colors}`}>
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="font-semibold text-sm">{title}</div>
        <div className="text-xs mt-0.5 opacity-80">{body}</div>
      </div>
      {href ? (
        <Link href={href} className="text-xs font-semibold flex items-center gap-1 hover:underline">
          {cta} <ArrowRight size={11} />
        </Link>
      ) : (
        <button className="text-xs font-semibold underline opacity-70 hover:opacity-100">
          {cta}
        </button>
      )}
    </div>
  );
}

function CashTile({ label, amount, sub, negative }: { label: string; amount: string; sub: string; negative?: boolean }) {
  return (
    <div>
      <div className="text-xs text-ink-slate">{label}</div>
      <div className={`text-xl font-bold ${negative ? "text-red-700" : "text-navy"}`}>{amount}</div>
      <div className="text-[11px] text-ink-light">{sub}</div>
    </div>
  );
}
