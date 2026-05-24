/**
 * Balance Sheet — client-friendly "what you own / what you owe / what's yours" framing.
 */
import { HelpCircle } from "lucide-react";

export default function BalanceSheetMockup() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Balance Sheet</div>
        <h1 className="text-3xl font-bold text-navy mt-1">What you own & what you owe</h1>
        <div className="text-sm text-ink-slate mt-1">As of May 24, 2026 · Snapshot in time</div>
      </div>

      <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
        <strong className="text-teal-dark">In plain English:</strong> If you sold everything today and paid
        off every debt, you'd have about <strong>$128,400</strong> left over. That's your "net worth" as a
        business. It's gone up <strong>$12,300</strong> since the start of the year — meaning the
        business is building value, not just spinning its wheels.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* What you own */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold mb-1">What you own</div>
          <div className="text-2xl font-bold text-emerald-700">$184,900</div>
          <div className="text-xs text-ink-slate mt-1">"Assets"</div>
          <div className="mt-4 space-y-2 text-sm">
            <Row label="Cash in the bank" amount="$71,050" tooltip="Operating + savings combined" />
            <Row label="Money customers owe you" amount="$48,200" tooltip="Invoices sent but not yet paid" />
            <Row label="Vehicles" amount="$52,400" tooltip="Two trucks, depreciated" />
            <Row label="Tools & equipment" amount="$13,250" />
          </div>
        </div>

        {/* What you owe */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold mb-1">What you owe</div>
          <div className="text-2xl font-bold text-amber-700">$56,500</div>
          <div className="text-xs text-ink-slate mt-1">"Liabilities"</div>
          <div className="mt-4 space-y-2 text-sm">
            <Row label="Bills to pay (vendors)" amount="$8,900" tooltip="Invoices from suppliers you owe" />
            <Row label="Credit card balance" amount="$6,240" />
            <Row label="Payroll taxes due" amount="$3,100" />
            <Row label="Truck loan" amount="$38,260" tooltip="11 months remaining" />
          </div>
        </div>

        {/* What's yours */}
        <div className="bg-white border-2 border-teal/40 rounded-2xl p-5">
          <div className="text-xs text-teal-dark uppercase tracking-wider font-semibold mb-1">What's yours</div>
          <div className="text-2xl font-bold text-teal-dark">$128,400</div>
          <div className="text-xs text-ink-slate mt-1">"Equity" — own minus owe</div>
          <div className="mt-4 space-y-2 text-sm">
            <Row label="Profit retained over the years" amount="$98,200" />
            <Row label="Your investments in" amount="$25,000" />
            <Row label="Profit this year so far" amount="$22,700" />
            <Row label="Money you've taken out" amount="-$17,500" tooltip="Owner draws" />
          </div>
        </div>
      </div>

      {/* The balance check */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center text-sm text-ink-slate">
        <strong className="text-navy">$184,900</strong> (you own) − <strong className="text-navy">$56,500</strong> (you owe) ={" "}
        <strong className="text-teal-dark">$128,400</strong> (yours) ✓
        <div className="text-xs text-ink-light mt-1">That's why it's called a "balance" sheet — these always equal out.</div>
      </div>
    </div>
  );
}

function Row({ label, amount, tooltip }: { label: string; amount: string; tooltip?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1 text-ink-slate">
        {label}
        {tooltip && (
          <span title={tooltip} className="cursor-help">
            <HelpCircle size={10} className="text-ink-light" />
          </span>
        )}
      </span>
      <span className="font-mono text-sm text-navy">{amount}</span>
    </div>
  );
}
