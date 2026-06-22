import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { intakeStatement } from "@/lib/statement-intake";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/portal/statements/process { path, name }
 *
 * Called right after a client uploads a statement on the portal Messages page
 * (via /api/portal/messages/upload-url). Runs the AI intake — identify the
 * account + period, match to QBO, rename, and file it to client_statements so
 * the bookkeeper sees it in the client's Statements section.
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const clientLinkId = ctxResult.ctx.clientLinkId;

  const body = await request.json().catch(() => ({}));
  const path = typeof body.path === "string" ? body.path : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!path || !name) {
    return NextResponse.json({ error: "path and name are required" }, { status: 400 });
  }
  // The client's uploads are scoped under their own client_link_id prefix.
  if (!path.startsWith(`${clientLinkId}/`)) {
    return NextResponse.json({ error: "Path is outside your folder" }, { status: 403 });
  }

  const service = createServiceSupabase();
  const result = await intakeStatement(service, {
    clientLinkId,
    storagePath: path,
    originalName: name,
    uploadedBy: null,
    uploadedVia: "portal",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  // Keep the client's confirmation generic — they don't need the QBO match.
  return NextResponse.json({ ok: true, display_name: result.display_name });
}
