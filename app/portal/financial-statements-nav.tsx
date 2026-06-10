"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BarChart3, ChevronDown, FileText, Scale, Waves } from "lucide-react";

const SUB_LINKS = [
  { href: "/portal/profit-loss", label: "Profit & Loss", icon: FileText },
  { href: "/portal/balance-sheet", label: "Balance Sheet", icon: Scale },
  { href: "/portal/cash-flow", label: "Cash Flow", icon: Waves },
];

/**
 * Collapsible "Financial Statements" group for the portal side nav.
 * Replaces the three flat statement links to keep the sidebar compact.
 *
 * - Clicking the label navigates to the /portal/financial-statements hub
 *   (three big tiles).
 * - The chevron expands/collapses the three sub-links in place.
 * - Auto-expanded when the current page is any statement route, so the
 *   active statement is always visible in the nav.
 */
export function FinancialStatementsNav() {
  const pathname = usePathname() || "";
  const onStatementPage =
    pathname.startsWith("/portal/financial-statements") ||
    SUB_LINKS.some((s) => pathname.startsWith(s.href));
  const [open, setOpen] = useState(onStatementPage);

  return (
    <div>
      <div className="flex items-center rounded-lg text-sm text-white/75 hover:bg-white/5 hover:text-white">
        <Link
          href="/portal/financial-statements"
          className="flex items-center gap-3 px-3 py-2 flex-1 min-w-0"
        >
          <BarChart3 size={16} />
          <span className="flex-1">Financial Statements</span>
        </Link>
        <button
          onClick={() => setOpen(!open)}
          aria-label={open ? "Collapse financial statements" : "Expand financial statements"}
          aria-expanded={open}
          className="p-2 mr-1 rounded hover:bg-white/10"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {open && (
        <div className="mt-0.5 space-y-0.5">
          {SUB_LINKS.map((s) => {
            const active = pathname.startsWith(s.href);
            const Icon = s.icon;
            return (
              <Link
                key={s.href}
                href={s.href}
                className={`flex items-center gap-2.5 pl-9 pr-3 py-1.5 rounded-lg text-[13px] ${
                  active
                    ? "bg-white/10 text-white font-semibold"
                    : "text-white/60 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon size={13} />
                {s.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
