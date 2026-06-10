"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mail } from "lucide-react";
import { playSound } from "@/lib/sounds";

/**
 * Live "Messages" nav item for the client portal sidebar.
 *
 * Renders the same as the layout's static NavLink, but self-polls the
 * unread count every 30s: red pill with the count, and a chime when a NEW
 * bookkeeper message arrives mid-session. The server-rendered initialCount
 * keeps the badge correct on first paint (no flash-of-zero). When the
 * client is ON the messages page the thread marks everything read, so the
 * badge clears on the next poll.
 */
export function MessagesNavLink({ initialCount }: { initialCount: number }) {
  const pathname = usePathname();
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    let prev: number | null = initialCount;
    let stopped = false;
    async function check() {
      try {
        const res = await fetch("/api/portal/messages/unread-count");
        if (!res.ok || stopped) return;
        const json = await res.json();
        if (typeof json.count !== "number") return;
        if (prev !== null && json.count > prev) playSound("message_received");
        prev = json.count;
        setCount(json.count);
      } catch {
        /* transient — next poll retries */
      }
    }
    const id = setInterval(check, 30_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onThread = pathname === "/portal/messages";

  return (
    <Link
      href="/portal/messages"
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-white/75 hover:bg-white/5 hover:text-white"
    >
      <Mail size={16} />
      <span className="flex-1">Messages</span>
      {count > 0 && !onThread && (
        <span className="text-[9px] font-bold text-white px-1.5 py-0.5 rounded bg-red-500 rounded-full min-w-[18px] text-center">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
