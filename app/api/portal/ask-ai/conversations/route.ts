import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/ask-ai/conversations
 *   (no params)  → list the signed-in client's saved Ask-AI conversations
 *   ?id=<uuid>   → the messages of one conversation (ownership-checked)
 *
 * Scoped to the portal user via resolvePortalContext, so a client can only
 * ever see their own conversations.
 */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const service = createServiceSupabase();
  const id = new URL(request.url).searchParams.get("id");

  if (id) {
    const { data: conv } = await (service as any)
      .from("ai_conversations")
      .select("id, title")
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    const { data: messages } = await (service as any)
      .from("ai_messages")
      .select("role, content, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });
    return NextResponse.json({ conversation: conv, messages: messages || [] });
  }

  const { data: conversations } = await (service as any)
    .from("ai_conversations")
    .select("id, title, updated_at")
    .eq("user_id", ctx.userId)
    .order("updated_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ conversations: conversations || [] });
}
