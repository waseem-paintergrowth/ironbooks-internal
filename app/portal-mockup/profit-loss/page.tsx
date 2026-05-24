/**
 * Profit & Loss — client-friendly view.
 *
 * Strategy: keep the numbers accurate but rename everything in plain English,
 * group aggressively, and expose details on-demand. Hover any term to see
 * "what does this mean."
 */
import { HelpCircle, ChevronDown } from "lucide-react";

export default function ProfitLossMockup() {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Profit & Loss</div>
          <h1 className="text-3xl font-bold text-navy mt-1">How you made money in May</h1>
          <div className="text-sm text-ink-slate mt-1">May 1 – May 24, 2026 · Updated daily</div>
        </div>
        <div className="flex items-center gap-2">
          <select className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm bg-white">
            <option>This month (May)</option>
            <option>Last month (April)</option>
            <option>This quarter (Q2)</option>
            <option>Year to date</option>
            <option>Last 12 months</option>
          </select>
          <button className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm bg-white">
            Download PDF
          </button>
        </div>
      </div>

      {/* AI-narrated summary at the top */}
      <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
        <strong className="text-teal-dark">In plain English:</strong> You earned <strong>$84,200</strong> from
        painting jobs this month. About <strong>$45,000</strong> went straight to costs of doing the work
        (paint, subs, materials). Another <strong>$17,100</strong> covered running the business (insurance,
        vehicles, software). That leaves <strong>$22,100</strong> in profit — about <strong>26 cents</strong> of
        every dollar you brought in.
      </div>

      {/* The statement */}
      <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100">
        {/* Income */}
        <Section title="Money in" subtitle="What customers paid you" amount="$84,200" tone="emerald">
          <Line label="Painting jobs (residential)" amount="$58,400" />
          <Line label="Painting jobs (commercial)" amount="$25,300" />
          <Line label="Misc / other" amount="$500" tooltip="Small one-off charges like materials reimbursements" />
        </Section>

        {/* COGS */}
        <Section title="Direct job costs" subtitle="What it cost to do the work" amount="$45,000" tone="amber">
          <Line label="Paint & materials" amount="$18,200" />
          <Line label="Subcontractors" amount="$22,400" tooltip="Workers you hired job-by-job (1099)" />
          <Line label="Job supplies" amount="$3,100" />
          <Line label="Equipment rental" amount="$1,300" />
        </Section>

        <SubtotalRow label="Gross profit (money in minus job costs)" amount="$39,200" tooltip="What's left after paying for the work itself, before overhead." />

        {/* Operating expenses */}
        <Section title="Running the business" subtitle="Overhead — not tied to any one job" amount="$17,100" tone="amber">
          <Line label="Vehicle expenses" amount="$3,800" />
          <Line label="Insurance" amount="$2,400" />
          <Line label="Office & admin" amount="$1,900" />
          <Line label="Software & subscriptions" amount="$1,200" />
          <Line label="Marketing" amount="$2,100" />
          <Line label="Bank & card fees" amount="$340" />
          <Line label="Other" amount="$5,360" />
        </Section>

        {/* Bottom line */}
        <div className="px-6 py-5 bg-teal/5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Bottom line</div>
              <div className="text-2xl font-bold text-navy mt-1">Profit (what's left)</div>
              <div className="text-xs text-ink-slate mt-1">26% profit margin — healthy for painting</div>
            </div>
            <div className="text-3xl font-bold text-emerald-700">$22,100</div>
          </div>
        </div>
      </div>

      {/* Glossary popout */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">New to reading this?</strong> Hover any line with a{" "}
        <HelpCircle size={11} className="inline" /> for a plain-English explanation. Or{" "}
        <a href="/portal-mockup/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>{" "}
        any question about these numbers.
      </div>
    </div>
  );
}

function Section({
  title, subtitle, amount, tone, children,
}: { title: string; subtitle: string; amount: string; tone: "emerald" | "amber"; children: React.ReactNode }) {
  return (
    <details className="px-6 py-4 group" open>
      <summary className="flex items-center justify-between cursor-pointer list-none">
        <div className="flex items-center gap-2">
          <ChevronDown size={14} className="text-ink-slate group-open:rotate-0 -rotate-90 transition-transform" />
          <div>
            <div className="font-bold text-navy">{title}</div>
            <div className="text-xs text-ink-slate">{subtitle}</div>
          </div>
        </div>
        <div className={`text-lg font-bold ${tone === "emerald" ? "text-emerald-700" : "text-amber-700"}`}>
          {amount}
        </div>
      </summary>
      <div className="mt-3 ml-6 space-y-1.5">{children}</div>
    </details>
  );
}

function Line({ label, amount, tooltip }: { label: string; amount: string; tooltip?: string }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="flex items-center gap-1.5 text-ink-slate">
        {label}
        {tooltip && (
          <span title={tooltip} className="cursor-help">
            <HelpCircle size={11} className="text-ink-light" />
          </span>
        )}
      </div>
      <div className="font-mono text-navy">{amount}</div>
    </div>
  );
}

function SubtotalRow({ label, amount, tooltip }: { label: string; amount: string; tooltip?: string }) {
  return (
    <div className="px-6 py-3 bg-slate-50 flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-navy">
        {label}
        {tooltip && (
          <span title={tooltip} className="cursor-help">
            <HelpCircle size={11} className="text-ink-light" />
          </span>
        )}
      </div>
      <div className="font-bold text-navy">{amount}</div>
    </div>
  );
}
