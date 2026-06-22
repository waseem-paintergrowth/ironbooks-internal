import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireStaff } from "@/lib/cleanup-system/auth";
import { intakeStatement } from "@/lib/statement-intake";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET  /api/clients/[id]/statements          → list filed statements
 * POST /api/clients/[id]/statements { path, name } → run AI intake on an
 *      already-uploaded file and file it. id = client_link_id.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data, error } = await (service as any)
    .from("client_statements")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .order("period_year", { ascending: false, nullsFirst: false })
    .order("period_month", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ statements: data || [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const path = typeof body.path === "string" ? body.path : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!path || !name) {
    return NextResponse.json({ error: "path and name are required" }, { status: 400 });
  }
  // Ownership boundary: the upload-url route scopes paths under the client's id.
  if (!path.startsWith(`${clientLinkId}/`)) {
    return NextResponse.json({ error: "Path is outside this client's folder" }, { status: 403 });
  }

  const service = createServiceSupabase();
  const result = await intakeStatement(service, {
    clientLinkId,
    storagePath: path,
    originalName: name,
    uploadedBy: auth.userId,
    uploadedVia: "bookkeeper",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  return NextResponse.json(result);
}
