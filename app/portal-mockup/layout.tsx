/**
 * Client portal mockup shell.
 *
 * Static — uses fake data throughout. Lives at /portal-mockup/* so we can
 * click through with no auth gate. When we move to building the real
 * portal, the layout + screens become real components and the routes
 * shift to /portal/[client_id]/*.
 *
 * Design tone vs SNAP:
 *   - More whitespace, larger type
 *   - Friendly language ("Who owes you" not "A/R Aging")
 *   - Reassuring colors (teal + soft amber + warm grays)
 *   - Mobile-responsive — clients use phones
 */
import Link from "next/link";
import { Home, FileText, Scale, Wallet, Receipt, MessageSquare, GraduationCap, Settings, LogOut } from "lucide-react";

export default function PortalMockupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Mockup banner — make it obvious this isn't real */}
      <div className="bg-amber-100 border-b border-amber-300 px-4 py-1.5 text-center text-xs text-amber-900">
        <strong>Mockup</strong> — static screens with fake data, for design review.
        Real portal lives at <code className="bg-amber-200 px-1 rounded">/portal/[client_id]</code> when built.
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-60 bg-[#0F1F2E] text-white min-h-[calc(100vh-32px)] flex flex-col">
          <div className="px-5 py-5 border-b border-white/10">
            <div className="font-bold text-base">Camellia Painting Pros</div>
            <div className="text-xs text-white/50 mt-0.5">via Ironbooks</div>
          </div>

          <nav className="flex-1 px-2 py-3 space-y-0.5">
            <NavLink href="/portal-mockup" icon={Home} label="Overview" />
            <NavLink href="/portal-mockup/profit-loss" icon={FileText} label="Profit & Loss" />
            <NavLink href="/portal-mockup/balance-sheet" icon={Scale} label="Balance Sheet" />
            <NavLink href="/portal-mockup/whos-paying" icon={Wallet} label="Who owes you" />
            <NavLink href="/portal-mockup/whats-due" icon={Receipt} label="What you owe" />
            <NavLink href="/portal-mockup/ask-ai" icon={MessageSquare} label="Ask the AI" badge="NEW" />
            <NavLink href="/portal-mockup/learn" icon={GraduationCap} label="Learn" />
          </nav>

          <div className="px-3 py-3 border-t border-white/10 space-y-1">
            <Link href="/portal-mockup/settings" className="flex items-center gap-2 px-3 py-2 rounded text-sm text-white/65 hover:bg-white/5 hover:text-white">
              <Settings size={14} /> Settings
            </Link>
            <button className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-white/65 hover:bg-white/5 hover:text-white">
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 max-w-5xl mx-auto px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavLink({ href, icon: Icon, label, badge }: { href: string; icon: any; label: string; badge?: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-white/75 hover:bg-white/5 hover:text-white"
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="text-[9px] font-bold bg-teal text-white px-1.5 py-0.5 rounded">
          {badge}
        </span>
      )}
    </Link>
  );
}
