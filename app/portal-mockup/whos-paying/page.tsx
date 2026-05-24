/**
 * "Who owes you" — A/R Aging in plain language.
 *
 * Replaces "A/R Aging Detail" jargon with a customer-by-customer view of
 * outstanding invoices, sorted by what needs the most attention.
 */
import { AlertCircle, Clock, Mail, Phone } from "lucide-react";

export default function WhosPaying() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Outstanding invoices</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Who owes you money</h1>
        <div className="text-sm text-ink-slate mt-1">$48,200 across 11 customers</div>
      </div>

      <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
        <strong className="text-teal-dark">Heads up:</strong> $8,400 of this is more than 30 days late.
        Two customers are the biggest concern — Hudson Construction (47 days overdue) and Pinnacle Builders
        (35 days overdue). Want help drafting a polite follow-up email?{" "}
        <a href="/portal-mockup/ask-ai" className="text-teal-dark font-semibold underline">Ask the AI</a>.
      </div>

      {/* Bucket summary */}
      <div className="grid grid-cols-4 gap-3">
        <Bucket label="Current (not yet due)" amount="$28,400" count={6} color="emerald" />
        <Bucket label="1–30 days late" amount="$11,400" count={3} color="amber" />
        <Bucket label="31–60 days late" amount="$5,000" count={1} color="orange" />
        <Bucket label="60+ days late" amount="$3,400" count={1} color="red" />
      </div>

      {/* Customer list */}
      <div className="space-y-3">
        <CustomerCard
          name="Hudson Construction"
          contact="Mike Hudson · mike@hudsonbuild.com"
          totalOwed="$8,400"
          oldestDays={47}
          invoices={[
            { num: "INV-1042", date: "Apr 7, 2026", amount: "$5,200", daysOverdue: 47 },
            { num: "INV-1058", date: "Apr 19, 2026", amount: "$3,200", daysOverdue: 35 },
          ]}
          urgent
        />
        <CustomerCard
          name="Pinnacle Builders"
          contact="Sarah Lee · sarah@pinnacle.com"
          totalOwed="$5,000"
          oldestDays={35}
          invoices={[
            { num: "INV-1051", date: "Apr 19, 2026", amount: "$5,000", daysOverdue: 35 },
          ]}
        />
        <CustomerCard
          name="Brightway Properties"
          contact="Jane Brightway · jane@brightway.com"
          totalOwed="$11,400"
          oldestDays={18}
          invoices={[
            { num: "INV-1067", date: "May 6, 2026", amount: "$6,400", daysOverdue: 18 },
            { num: "INV-1071", date: "May 12, 2026", amount: "$5,000", daysOverdue: 12 },
          ]}
        />
        <CustomerCard
          name="Riverside HOA"
          contact="Bob Chen · bchen@riverside.com"
          totalOwed="$4,800"
          oldestDays={3}
          invoices={[
            { num: "INV-1078", date: "May 21, 2026", amount: "$4,800", daysOverdue: 0 },
          ]}
        />
        <div className="text-center text-sm text-ink-slate py-3">
          + 7 more customers totaling $18,600
        </div>
      </div>
    </div>
  );
}

function Bucket({ label, amount, count, color }: { label: string; amount: string; count: number; color: string }) {
  const colors: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    orange: "bg-orange-50 border-orange-200 text-orange-900",
    red: "bg-red-50 border-red-200 text-red-900",
  };
  return (
    <div className={`p-3 rounded-xl border ${colors[color]}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="text-lg font-bold mt-1">{amount}</div>
      <div className="text-[11px] opacity-70">{count} invoice{count === 1 ? "" : "s"}</div>
    </div>
  );
}

function CustomerCard({
  name, contact, totalOwed, oldestDays, invoices, urgent,
}: {
  name: string; contact: string; totalOwed: string; oldestDays: number;
  invoices: { num: string; date: string; amount: string; daysOverdue: number }[];
  urgent?: boolean;
}) {
  return (
    <div className={`bg-white border rounded-2xl p-5 ${urgent ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-navy">{name}</h3>
            {urgent && (
              <span className="text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                <AlertCircle size={9} className="inline mr-0.5" />
                URGENT
              </span>
            )}
          </div>
          <div className="text-xs text-ink-slate mt-0.5">{contact}</div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-navy">{totalOwed}</div>
          <div className="text-xs text-ink-slate">
            <Clock size={10} className="inline mr-0.5" />
            Oldest: {oldestDays}d
          </div>
        </div>
      </div>
      <div className="space-y-1 mb-3">
        {invoices.map((inv) => (
          <div key={inv.num} className="flex items-center justify-between text-xs text-ink-slate">
            <span>{inv.num} · {inv.date}</span>
            <span className="font-mono">
              {inv.amount}
              {inv.daysOverdue > 0 && (
                <span className="text-red-700 font-semibold ml-2">({inv.daysOverdue}d late)</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="text-xs font-semibold px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1">
          <Mail size={11} /> Send reminder
        </button>
        <button className="text-xs font-semibold px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1">
          <Phone size={11} /> Mark as called
        </button>
      </div>
    </div>
  );
}
