import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/admin/clients/[id]/email   { email }
 *
 * Update a client's email AFTER account creation — the thing there was no UI
 * for. Updates BOTH:
 *   1. client_links.client_email  (the business contact email — invites,
 *      statements, "ask the AI" recipient resolution)
 *   2. the portal user's auth LOGIN email (Supabase auth + public.users.email)
 *      when the client has exactly one active portal login.
 *
 * Admin/lead only. With more than one portal login we change only the contact
 * email and return a note (ambiguous which login to repoint). If the new email
 * is already registered to another auth user, the contact email still updates
 * and we report that the login couldn't change.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // 1. Business contact email — always.
  const { error: clErr } = await service
    .from("client_links")
    .update({ client_email: email } as any)
    .eq("id", clientLinkId);
  if (clErr) return NextResponse.json({ error: clErr.message }, { status: 500 });

  // 2. Portal login email — only when there's exactly one active portal user.
  const { data: maps } = await (service as any)
    .from("client_users")
    .select("user_id")
    .eq("client_link_id", clientLinkId)
    .eq("active", true);
  const userIds = ((maps as any[]) || []).map((m) => m.user_id).filter(Boolean);

  let portalUpdated = 0;
  let note: string | null = null;

  if (userIds.length === 1) {
    const uid = userIds[0];
    const { data: u } = await service
      .from("users")
      .select("id, role")
      .eq("id", uid)
      .maybeSingle();
    if ((u as any)?.role === "client") {
      const { error: authErr } = await (service as any).auth.admin.updateUserById(uid, {
        email,
        email_confirm: true,
      });
      if (authErr) {
        return NextResponse.json(
          {
            error: `Saved the contact email, but couldn't change the portal login — ${authErr.message}. The new address may already belong to another login.`,
            partial: true,
          },
          { status: 409 }
        );
      }
      await service.from("users").update({ email } as any).eq("id", uid);
      portalUpdated = 1;
    }
  } else if (userIds.length > 1) {
    note = `Changed the contact email only — this client has ${userIds.length} portal logins, so update each login individually to avoid repointing the wrong one.`;
  }

  await service.from("audit_log").insert({
    event_type: "client_email_updated",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      new_email: email,
      portal_logins_updated: portalUpdated,
    } as any,
  });

  return NextResponse.json({ ok: true, email, portal_updated: portalUpdated, note });
}
