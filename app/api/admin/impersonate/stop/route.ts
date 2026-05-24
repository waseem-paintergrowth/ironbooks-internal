import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { readImpersonationCookie, clearImpersonationCookie } from "@/lib/impersonation";

/**
 * POST /api/admin/impersonate/stop
 *
 * Clears the impersonation cookie + audit log entry. Safe to call when
 * no impersonation is active (no-ops, returns ok).
 */
export async function POST() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const targetUserId = await readImpersonationCookie();
  await clearImpersonationCookie();

  if (targetUserId) {
    const service = createServiceSupabase();
    await service.from("audit_log").insert({
      event_type: "portal_impersonate_stop",
      user_id: user.id,
      request_payload: {
        target_user_id: targetUserId,
      } as any,
    });
  }

  return NextResponse.json({ ok: true, redirect: "/admin/invite-client" });
}
