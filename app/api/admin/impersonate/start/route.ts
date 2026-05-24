import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { writeImpersonationCookie } from "@/lib/impersonation";

/**
 * POST /api/admin/impersonate/start
 *
 * Body: { target_user_id: string }    // a client user id to impersonate
 *   OR: { client_link_id: string }    // resolve to that client's first active portal user
 *
 * Admin/lead only. Validates the target is a client with an active
 * client_users mapping, sets the impersonation cookie, writes an audit
 * log entry. Returns the redirect target (always /portal) so the caller
 * can navigate after the cookie is set.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (role !== "admin" && role !== "lead") {
    return NextResponse.json(
      { error: "Forbidden — admin or lead only" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  let targetUserId: string | undefined = body.target_user_id;
  const clientLinkId: string | undefined = body.client_link_id;

  // If only a client_link_id is provided, find the first active portal user
  // for that client. Useful for the Clients-list dropdown shortcut.
  if (!targetUserId && clientLinkId) {
    const { data: mapping } = await service
      .from("client_users" as any)
      .select("user_id")
      .eq("client_link_id", clientLinkId)
      .eq("active", true)
      .order("first_login_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (!mapping) {
      return NextResponse.json(
        {
          error: "No portal user yet for this client. Invite one first from /admin/invite-client.",
          code: "no_portal_user",
        },
        { status: 404 }
      );
    }
    targetUserId = (mapping as any).user_id;
  }

  if (!targetUserId) {
    return NextResponse.json(
      { error: "Either target_user_id or client_link_id required" },
      { status: 400 }
    );
  }

  // Validate target
  const { data: target } = await service
    .from("users")
    .select("id, role, is_active, email, full_name")
    .eq("id", targetUserId)
    .single();
  if (!target) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }
  if ((target as any).role !== "client") {
    return NextResponse.json(
      { error: "Can only impersonate client portal users (not staff)" },
      { status: 400 }
    );
  }
  if ((target as any).is_active === false) {
    return NextResponse.json(
      { error: "Target user is disabled" },
      { status: 400 }
    );
  }

  const { data: mapping } = await service
    .from("client_users" as any)
    .select("client_link_id, active")
    .eq("user_id", targetUserId)
    .eq("active", true)
    .maybeSingle();
  if (!mapping) {
    return NextResponse.json(
      { error: "Target user has no active client mapping" },
      { status: 400 }
    );
  }

  // Set cookie + audit
  await writeImpersonationCookie(targetUserId);

  await service.from("audit_log").insert({
    event_type: "portal_impersonate_start",
    user_id: user.id,
    request_payload: {
      admin_name: (actor as any)?.full_name || user.email,
      target_user_id: targetUserId,
      target_email: (target as any).email,
      target_full_name: (target as any).full_name,
      client_link_id: (mapping as any).client_link_id,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    redirect: "/portal",
    target: {
      user_id: targetUserId,
      full_name: (target as any).full_name,
      email: (target as any).email,
    },
  });
}
