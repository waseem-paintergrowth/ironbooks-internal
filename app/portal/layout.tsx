import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  Home, FileText, Scale, Wallet, Receipt, MessageSquare,
  GraduationCap, Settings, LogOut,
} from "lucide-react";
import { SignOutButton } from "./sign-out-button";

/**
 * Real client portal shell. Auth-gated: only role='client' with an active
 * client_users mapping gets through. The shell pulls the client's display
 * name so the sidebar identifies which business they're looking at.
 *
 * Differs from /portal-mockup/layout.tsx (the static design preview) by:
 *   - Real auth (middleware sends non-clients away; this layer resolves
 *     the client_link_id from the mapping table)
 *   - Real sign-out (vs the mockup's dead button)
 *   - Live "client_name" lookup
 *   - No "this is a mockup" amber banner
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  // Pull the role + client mapping in one shot. Anyone reaching this layout
  // already passed middleware's role gate, but defense-in-depth.
  const { data: profile } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if ((profile as any)?.role !== "client") {
    redirect("/dashboard");
  }

  const { data: mapping } = await service
    .from("client_users" as any)
    .select("client_link_id, active")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (!mapping || !(mapping as any).client_link_id) {
    // Account exists but no client mapping — show the "still being set up"
    // state. Avoids a confusing redirect loop when an invite was botched.
    return (
      <NoClientMappingState fullName={(profile as any)?.full_name || user.email || ""} />
    );
  }

  const clientLinkId = (mapping as any).client_link_id as string;
  const { data: client } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", clientLinkId)
    .single();

  const clientName = (client as any)?.client_name || "Your Business";

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      <div className="flex">
        <aside className="w-60 bg-[#0F1F2E] text-white min-h-screen flex flex-col">
          <div className="px-5 py-5 border-b border-white/10">
            <div className="font-bold text-base truncate" title={clientName}>
              {clientName}
            </div>
            <div className="text-xs text-white/50 mt-0.5">via Ironbooks</div>
          </div>

          <nav className="flex-1 px-2 py-3 space-y-0.5">
            <NavLink href="/portal" icon={Home} label="Overview" />
            <NavLink href="/portal/profit-loss" icon={FileText} label="Profit & Loss" />
            <NavLink href="/portal/balance-sheet" icon={Scale} label="Balance Sheet" />
            <NavLink href="/portal/whos-paying" icon={Wallet} label="Who owes you" />
            <NavLink href="/portal/whats-due" icon={Receipt} label="What you owe" />
            <NavLink href="/portal/ask-ai" icon={MessageSquare} label="Ask the AI" badge="NEW" />
            <NavLink href="/portal/learn" icon={GraduationCap} label="Learn" />
          </nav>

          <div className="px-3 py-3 border-t border-white/10 space-y-1">
            <Link
              href="/portal/settings"
              className="flex items-center gap-2 px-3 py-2 rounded text-sm text-white/65 hover:bg-white/5 hover:text-white"
            >
              <Settings size={14} /> Settings
            </Link>
            <SignOutButton />
          </div>
        </aside>

        <main className="flex-1 max-w-5xl mx-auto px-8 py-8">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href, icon: Icon, label, badge,
}: {
  href: string; icon: any; label: string; badge?: string;
}) {
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

/**
 * Shown when an invite was sent but the client_users mapping is missing
 * (or marked inactive). Prevents an infinite redirect loop and tells the
 * user what to do.
 */
function NoClientMappingState({ fullName }: { fullName: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF7] px-4">
      <div className="max-w-md text-center">
        <div className="text-2xl font-bold text-navy">Hi {fullName.split(" ")[0] || "there"} 👋</div>
        <p className="text-sm text-ink-slate mt-3">
          Your Ironbooks team is still finishing setting up your portal access.
          You should get an email when it's ready, usually within an hour.
        </p>
        <p className="text-xs text-ink-light mt-4">
          If this has been more than a day, reach out to your bookkeeper directly.
        </p>
      </div>
    </div>
  );
}
