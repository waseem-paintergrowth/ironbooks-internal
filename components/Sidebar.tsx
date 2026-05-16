"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, FilePlus2, Flag, Users, Settings, LogOut, BookOpen, Clock, Zap, Shield, Shuffle, CreditCard } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import type { Database } from "@/lib/database.types";

const standardItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/jobs/new", label: "New COA Cleanup", icon: FilePlus2, highlight: true },
  { href: "/rules/new", label: "Bank Rules", icon: Zap, highlight: true },
  { href: "/reclass/new", label: "Reclassify", icon: Shuffle, highlight: true },
  { href: "/stripe-recon/new", label: "Stripe AR Recon", icon: CreditCard, highlight: true },
  { href: "/flagged", label: "Flagged Queue", icon: Flag, showBadge: true },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/templates", label: "Master COA", icon: BookOpen },
  { href: "/history", label: "Job History", icon: Clock },
];

const adminItems = [
  { href: "/admin", label: "Admin", icon: Shield },
  { href: "/admin/audit", label: "Audit Log", icon: BookOpen },
];

const bottomItems = [
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [userName, setUserName] = useState<string>("");
  const [userRole, setUserRole] = useState<string>("");
  const [flaggedCount, setFlaggedCount] = useState<number>(0);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const [{ data: profile }, { data: stats }] = await Promise.all([
          supabase.from("users").select("full_name, role").eq("id", data.user.id).single(),
          supabase.from("dashboard_stats").select("flagged_for_lisa").single(),
        ]);

        if (profile) {
          setUserName(profile.full_name);
          setUserRole(profile.role);

          // Update last_login_at (fire and forget)
          supabase
            .from("users")
            .update({ last_login_at: new Date().toISOString() } as any)
            .eq("id", data.user.id)
            .then(() => {});
        }
        if (stats?.flagged_for_lisa) {
          setFlaggedCount(stats.flagged_for_lisa);
        }
      }
    });
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  }

  const isAdmin = userRole === "admin";

  return (
    <aside className="flex flex-col h-screen sticky top-0 w-60 bg-navy text-white">
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center rounded-lg font-bold bg-teal w-9 h-9 text-base">
            IB
          </div>
          <div>
            <div className="font-bold text-lg tracking-tight leading-none">IronBooks</div>
            <div className="text-xs mt-0.5 text-white/50">Bookkeeper OS</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {standardItems.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            pathname={pathname}
            badgeCount={item.showBadge ? flaggedCount : undefined}
          />
        ))}

        {isAdmin && (
          <>
            <div className="mt-4 mb-2 px-3 text-xs font-bold uppercase tracking-wider text-white/40">
              Admin
            </div>
            {adminItems.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} />
            ))}
          </>
        )}

        <div className="mt-4 pt-4 border-t border-white/10">
          {bottomItems.map((item) => (
            <NavItem key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
      </nav>

      <div className="px-3 py-4 border-t border-white/10">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg bg-white/5">
          <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-teal">
            {userName.charAt(0) || "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">
              {userName || "Loading..."}
            </div>
            <div className="text-xs leading-tight truncate text-white/50 capitalize">
              {userRole}
            </div>
          </div>
          <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  item,
  pathname,
  badgeCount,
}: {
  item: { href: string; label: string; icon: any; highlight?: boolean; showBadge?: boolean };
  pathname: string;
  badgeCount?: number;
}) {
  const active = pathname === item.href || pathname.startsWith(item.href + "/");
  const Icon = item.icon;
  const showCount = badgeCount !== undefined && badgeCount > 0;

  return (
    <Link
      href={item.href}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mb-0.5 ${
        active
          ? "bg-teal/25 text-white border-l-[3px] border-teal pl-[9px]"
          : "text-white/65 hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon size={17} />
      <span>{item.label}</span>
      {showCount && (
        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-500 text-white">
          {badgeCount}
        </span>
      )}
      {item.highlight && !active && !showCount && (
        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal text-white">
          +
        </span>
      )}
    </Link>
  );
}
