import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

const STAFF = ["admin", "lead", "bookkeeper"];
const ALL = ["admin", "lead", "bookkeeper", "viewer"];

const STATUSES = ["new", "open", "pending", "solved", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

/** GET /api/support/tickets/[id] — ticket + full message thread. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!ALL.includes((actor as any)?.role || "")) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const { data: ticket } = await (service as any)
    .from("support_tickets").select("*").eq("id", id).single();
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: messages } = await (service as any)
    .from("support_ticket_messages")
    .select("id, author_type, author_name, author_email, body_text, is_internal, created_at")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ ticket, messages: messages || [] });
}

/** PATCH /api/support/tickets/[id] — update status / priority / assignee / tags. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!STAFF.includes((actor as any)?.role || "")) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.status === "string" && STATUSES.includes(body.status)) patch.status = body.status;
  if (typeof body.priority === "string" && PRIORITIES.includes(body.priority)) patch.priority = body.priority;
  if ("assignee_id" in body) patch.assignee_id = body.assignee_id || null;
  if (Array.isArray(body.tags)) patch.tags = body.tags;

  const { error } = await (service as any).from("support_tickets").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
