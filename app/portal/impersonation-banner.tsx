"use client";

import { useRouter } from "next/navigation";
import { Eye, LogOut, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Sticky banner shown across the top of the portal whenever an admin is
 * impersonating a client. Designed to be unmissable — bright amber + an
 * explicit "Stop impersonating" button. Server-rendered by the portal
 * layout based on ctx.impersonating.
 */
export function ImpersonationBanner({
  clientName,
  clientUserName,
  realUserName,
}: {
  clientName: string;
  clientUserName: string;
  realUserName: string;
}) {
  const router = useRouter();
  const [stopping, setStopping] = useState(false);

  async function stop() {
    setStopping(true);
    try {
      const res = await fetch("/api/admin/impersonate/stop", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      router.push(body.redirect || "/admin/invite-client");
      // Force a full reload so the banner disappears and middleware re-evaluates
      router.refresh();
    } catch {
      setStopping(false);
    }
  }

  return (
    <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Eye size={14} className="flex-shrink-0" />
        <span className="truncate">
          <strong>Impersonating</strong> {clientUserName || "client user"} at{" "}
          <strong>{clientName}</strong>
          <span className="opacity-75 ml-2">· You are signed in as {realUserName}</span>
        </span>
      </div>
      <button
        onClick={stop}
        disabled={stopping}
        className="inline-flex items-center gap-1 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-50 px-3 py-1 rounded text-xs font-bold flex-shrink-0 ml-3"
      >
        {stopping ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
        Stop impersonating
      </button>
    </div>
  );
}
