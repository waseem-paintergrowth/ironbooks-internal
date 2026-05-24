import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/uncat-income/[scanId]
 *
 * Returns one scan + all its items. Drives the recovery review page.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: scan } = await service
    .from("uncat_income_scans" as any)
    .select("*")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });

  const { data: items } = await service
    .from("uncat_income_items" as any)
    .select("*")
    .eq("scan_id", scanId)
    .order("amount", { ascending: false });

  return NextResponse.json({
    ok: true,
    scan,
    items: items || [],
  });
}
