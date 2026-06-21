import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingBackfillClient } from "./backfill-client";

export const dynamic = "force-dynamic";

/**
 * /admin/billing-backfill — bulk-link clients to their Stripe customer.
 *
 * Only ~2 of 78 clients had a stripe_customer_id (the portal only ever matched
 * by exact email). This page proposes matches by email / custom domain /
 * company name, lets a senior review + correct them, then writes the approved
 * links so the portal Billing page resolves for everyone.
 */
export default async function BillingBackfillPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar
        title="Link Stripe customers"
        subtitle="Match clients to their Stripe customer so billing shows in their portal"
      />
      <div className="px-8 py-6">
        <BillingBackfillClient />
      </div>
    </AppShell>
  );
}
