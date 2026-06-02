import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HardcoreCleanupClient } from "./hardcore-cleanup-client";
import { UnifiedReviewClient } from "./unified-review-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/hardcore-cleanup
 *
 * Phase 1 of the Hardcore BS Cleanup — Logan-style mess: client switched
 * CRMs and QBO is now full of phantom duplicate invoices inflating A/R.
 *
 * Bookkeeper uploads CRM CSV → SNAP cross-references against QBO open
 * invoices → flags duplicates → bookkeeper picks JE write-off or direct
 * void per item → finalize pushes corrections to QBO.
 */
export default async function HardcoreCleanupPage({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  let latestRun: any = null;
  try {
    const { data, error } = await service
      .from("hardcore_cleanup_runs" as any)
      .select("*")
      .eq("client_link_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error) latestRun = data;
  } catch {}

  return (
    <AppShell>
      <TopBar
        title={`Hardcore BS Cleanup — ${(client as any).client_name}`}
        subtitle="Upload CRM job report · detect duplicate invoices from CRM-migration mess · push JE write-offs / voids to QBO"
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${client_id}/ar-recovery`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to A/R Recovery
        </Link>
        {/* Branch on workflow_version: v2 runs render the new 4-tab UI;
            v1 runs (Clean Cut Painters' in-flight cleanup) keep using the
            legacy single-bucket UI so nothing in-flight breaks. New uploads
            always create v2 runs (start route defaults to workflow_version=2). */}
        {latestRun && (latestRun as any).workflow_version === 2 ? (
          <UnifiedReviewClient
            clientLinkId={client_id}
            clientName={(client as any).client_name}
            initialRun={latestRun as any}
          />
        ) : (
          <HardcoreCleanupClient
            clientLinkId={client_id}
            clientName={(client as any).client_name}
            latestRun={latestRun}
          />
        )}
      </div>
    </AppShell>
  );
}
