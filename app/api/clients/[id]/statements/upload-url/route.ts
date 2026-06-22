import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireStaff } from "@/lib/cleanup-system/auth";
import {
  CLIENT_UPLOADS_BUCKET,
  sanitizeFilename,
  validateUploadMeta,
} from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/statements/upload-url
 *
 * Bookkeeper-side signed upload URL so the browser sends the statement PDF
 * straight to Supabase Storage (bypassing Vercel's ~4.5MB body cap). Mirrors
 * the portal flow; the resulting path is then handed to POST .../statements
 * for AI intake. id = client_link_id.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let meta: { name?: string; size?: number; content_type?: string };
  try {
    meta = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const validationError = validateUploadMeta(meta);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const safeName = sanitizeFilename(meta.name!);
  const yyyymm = new Date().toISOString().slice(0, 7);
  const path = `${clientLinkId}/${yyyymm}/${Date.now()}-${safeName}`;

  const service = createServiceSupabase();
  const { data, error } = await service.storage
    .from(CLIENT_UPLOADS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error(`[clients/statements/upload-url] signed URL failed for ${path}:`, error?.message);
    return NextResponse.json(
      { error: "Could not prepare the upload — try again in a moment" },
      { status: 500 }
    );
  }

  return NextResponse.json({ path: data.path, token: data.token });
}
