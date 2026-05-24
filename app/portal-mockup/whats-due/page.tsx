/**
 * "What you owe" — A/P Aging + upcoming obligations in plain language.
 */
import { Calendar, AlertCircle, Receipt } from "lucide-react";

export default function WhatsDue() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Bills & obligations</div>
        <h1 className="text-3xl font-bold text-navy mt-1">What you owe</h1>
        <div className="text-sm text-ink-slate mt-1">$56,500 total · $12,400 due in the next 30 days</div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 leading-relaxed">
        <strong>Cash flow check:</strong> You have <strong>$71,050</strong> in the bank and{" "}
        <strong>$12,400</strong> in bills due in the next 30 days, plus <strong>$4,200</strong> in
        quarterly taxes on June 4. You're in great shape — leaving plenty of room for payroll
        and operating expenses.
      </div>

      {/* Due soon */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <h3 className="font-bold text-navy mb-3">Due in the next 30 days</h3>
        <div className="space-y-2">
          <Bill due="Jun 4" daysAway={11} payee="IRS — Quarterly Taxes Q2" amount="$4,200" urgent />
          <Bill due="Jun 5" daysAway={12} payee="Sherwin-Williams" amount="$3,400" />
          <Bill due="Jun 8" daysAway={15} payee="Truck loan payment (Chase Auto)" amount="$847" recurring />
          <Bill due="Jun 12" daysAway={19} payee="Home Depot Pro" amount="$1,250" />
          <Bill due="Jun 15" daysAway={22} payee="Amex 62009" amount="$2,703" />
        </div>
      </div>

      {/* Vendor bills outstanding */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <h3 className="font-bold text-navy mb-3">All outstanding bills from vendors</h3>
        <div className="space-y-2">
          <VendorRow name="Sherwin-Williams" total="$3,400" oldestDays={9} bills={2} />
          <VendorRow name="Home Depot Pro" total="$1,250" oldestDays={4} bills={1} />
          <VendorRow name="Local Painters Co-op (subs)" total="$3,200" oldestDays={6} bills={3} />
          <VendorRow name="Quickbooks Payroll" total="$1,050" oldestDays={2} bills={1} />
        </div>
      </div>

      {/* Recurring obligations */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <h3 className="font-bold text-navy mb-3">Recurring monthly obligations</h3>
        <div className="grid grid-cols-2 gap-3">
          <RecurringRow label="Truck loan (Chase Auto)" amount="$847/mo" months="11 left" />
          <RecurringRow label="General Liability Insurance" amount="$340/mo" />
          <RecurringRow label="Workers Comp" amount="$610/mo" />
          <RecurringRow label="Software (QBO, Jobber, etc.)" amount="$420/mo" />
        </div>
      </div>
    </div>
  );
}

function Bill({ due, daysAway, payee, amount, urgent, recurring }: { due: string; daysAway: number; payee: string; amount: string; urgent?: boolean; recurring?: boolean }) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg ${urgent ? "bg-red-50 border border-red-200" : "bg-slate-50 border border-slate-100"}`}>
      <div className="flex items-center gap-3">
        <Calendar size={14} className={urgent ? "text-red-700" : "text-ink-slate"} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-navy">{payee}</span>
            {urgent && <span className="text-[9px] font-bold bg-red-100 text-red-800 px-1 rounded">URGENT</span>}
            {recurring && <span className="text-[9px] font-bold bg-slate-100 text-ink-slate px-1 rounded">RECURRING</span>}
          </div>
          <div className="text-xs text-ink-slate">{due} · {daysAway} days away</div>
        </div>
      </div>
      <div className="text-lg font-bold text-navy">{amount}</div>
    </div>
  );
}

function VendorRow({ name, total, oldestDays, bills }: { name: string; total: string; oldestDays: number; bills: number }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
      <div className="text-sm">
        <div className="font-semibold text-navy">{name}</div>
        <div className="text-xs text-ink-slate">{bills} bill{bills === 1 ? "" : "s"} · oldest {oldestDays}d</div>
      </div>
      <div className="font-bold text-navy">{total}</div>
    </div>
  );
}

function RecurringRow({ label, amount, months }: { label: string; amount: string; months?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Receipt size={12} className="text-ink-slate" />
      <span className="flex-1 text-ink-slate">{label}</span>
      <span className="font-semibold text-navy">{amount}</span>
      {months && <span className="text-[10px] text-ink-light">{months}</span>}
    </div>
  );
}
