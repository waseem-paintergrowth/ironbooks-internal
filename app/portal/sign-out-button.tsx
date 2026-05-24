"use client";

import { createBrowserClient } from "@supabase/ssr";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Database } from "@/lib/database.types";

/**
 * Portal sign-out. Splits into its own client component so the layout
 * stays server-rendered. Standard Supabase auth.signOut + push to /auth/login.
 */
export function SignOutButton() {
  const router = useRouter();
  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/auth/login");
  }

  return (
    <button
      onClick={handleSignOut}
      className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-white/65 hover:bg-white/5 hover:text-white"
    >
      <LogOut size={14} /> Sign out
    </button>
  );
}
