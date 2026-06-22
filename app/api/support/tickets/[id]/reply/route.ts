import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

const STAFF = ["admin", "lead", "bookkeeper"];

/**
 * POST /api/support/tickets/[id]/reply
 * Add an agent message — a public reply to the customer, or an internal note.
 * A public reply bumps last_message_* and moves a 'new' ticket to 'open'.
 *
 * NOTE: the outbound email send is intentionally deferred. Replies are recorded
 * in the thread now; once inbound-email ingestion is wired (and we have the
 * customer's Message-ID for threading), send here via lib/client-comms
 * `sendResendEmail` with In-Reply-To/References headers.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!STAFF.includes(role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const text = (body.body || "").trim();
  const isInternal = !!body.is_internal;
  if (!text) return NextResponse.json({ error: "Empty message" }, { status: 400 });

  const { data: ticket } = await (service as any)
    .from("support_tickets").select("id, status").eq("id", id).single();
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: message, error } = await (service as any)
    .from("support_ticket_messages")
    .insert({
      ticket_id: id,
      author_type: "agent",
      author_id: user.id,
      author_name: (actor as any)?.full_name || "Agent",
      is_internal: isInternal,
      body_text: text,
    })
    .select("id, author_type, author_name, author_email, body_text, is_internal, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Public replies move the ticket forward; internal notes don't touch the
  // customer-facing state.
  if (!isInternal) {
    const patch: Record<string, any> = {
      last_message_at: message.created_at,
      last_message_preview: text.slice(0, 120),
      last_message_from: "agent",
      updated_at: new Date().toISOString(),
    };
    if (ticket.status === "new") patch.status = "open";
    await (service as any).from("support_tickets").update(patch).eq("id", id);
    // TODO: send outbound email to the customer here once ingestion is wired.
  }

  return NextResponse.json({ message });
}
