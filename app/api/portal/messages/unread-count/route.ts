import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/messages/unread-count
 *
 * Unread bookkeeper→client messages for the signed-in portal user's client.
 * Powers the live red badge + chime on the portal "Messages" nav item —
 * polled, so it's a single head-count query.
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ count: 0 });
  }
  const service = createServiceSupabase();
  const { count, error } = await (service as any)
    .from("client_communications")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", ctxResult.ctx.clientLinkId)
    .eq("direction", "to_client")
    .is("read_at", null);
  if (error) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: count ?? 0 });
}
