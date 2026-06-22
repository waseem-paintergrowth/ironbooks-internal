import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

const STAFF = ["admin", "lead", "bookkeeper"];

/**
 * POST /api/support/tickets
 * Create a ticket manually (staff). Auto-links to a client when the requester
 * email matches client_links.client_email. Optional first message is recorded
 * as the customer's opening message.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!STAFF.includes(role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const subject = (body.subject || "").trim();
  const email = (body.requester_email || "").trim();
  const name = (body.requester_name || "").trim() || null;
  const firstMessage = (body.body || "").trim();
  if (!subject || !email) {
    return NextResponse.json({ error: "Subject and requester email are required." }, { status: 400 });
  }

  // Match the requester to a client record (the "see client info" link).
  let clientLinkId: string | null = null;
  let clientName: string | null = null;
  try {
    const { data: cl } = await (service as any)
      .from("client_links")
      .select("id, client_name")
      .ilike("client_email", email)
      .limit(1)
      .maybeSingle();
    if (cl) { clientLinkId = cl.id; clientName = cl.client_name; }
  } catch { /* matching is best-effort */ }

  const nowIso = new Date().toISOString();
  const { data: ticket, error } = await (service as any)
    .from("support_tickets")
    .insert({
      subject,
      requester_email: email,
      requester_name: name,
      client_link_id: clientLinkId,
      status: "open",
      priority: "normal",
      channel: "manual",
      last_message_at: nowIso,
      last_message_preview: firstMessage ? firstMessage.slice(0, 120) : subject,
      last_message_from: "customer",
      created_by: user.id,
    })
    .select("id, subject, requester_email, requester_name, client_link_id, status, priority, channel, assignee_id, tags, last_message_at, last_message_preview, last_message_from, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (firstMessage) {
    await (service as any).from("support_ticket_messages").insert({
      ticket_id: ticket.id,
      author_type: "customer",
      author_name: name,
      author_email: email,
      body_text: firstMessage,
    });
  }

  return NextResponse.json({
    ticket: { ...ticket, client_name: clientName, assignee_name: null },
  });
}
