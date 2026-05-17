import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import Link from "next/link";
import { Plus, ArrowRight, MoreVertical, Zap, CheckCircle2, Flag, TrendingUp, FilePlus2, Shuffle, CreditCard, Receipt, AlertCircle } from "lucide-react";

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: stats } = await supabase.from("dashboard_stats").select("*").single();
  const { data: jobs } = await supabase.from("active_jobs_view").select("*").limit(10);

  // Count this user's items still flagged across all 3 sources (only their own jobs).
  // Senior bookkeepers see this too, but it's most relevant to juniors who don't have
  // access to /flagged. Service client used so we can aggregate without RLS friction.
  let myPendingReview = { coa: 0, reclass: 0, stripe: 0, total: 0, jobs: [] as any[] };
  if (user) {
    const service = createServiceSupabase();
    const [coaR, reclassR, stripeR] = await Promise.all([
      service
        .from("coa_actions")
        .select("id, job_id, coa_jobs!inner(id, bookkeeper_id, client_links(client_name))")
        .eq("action", "flag")
        .eq("executed", false)
        .eq("coa_jobs.bookkeeper_id", user.id),
      service
        .from("reclassifications")
        .select("id, reclass_job_id, reclass_jobs!reclass_job_id!inner(id, bookkeeper_id, client_links(client_name))")
        .eq("decision", "flagged")
        .eq("reclass_jobs.bookkeeper_id", user.id)
        .limit(500),
      service
        .from("stripe_recon_matches")
        .select("id, job_id, stripe_recon_jobs!inner(id, bookkeeper_id, client_links(client_name))")
        .eq("decision", "flagged")
        .eq("executed", false)
        .eq("stripe_recon_jobs.bookkeeper_id", user.id),
    ]);
    const byJob = new Map<string, { client_name: string; source: string; count: number }>();
    function bump(jobId: string, clientName: string, source: string) {
      const k = `${source}::${jobId}`;
      if (!byJob.has(k)) byJob.set(k, { client_name: clientName, source, count: 0 });
      byJob.get(k)!.count++;
    }
    for (const r of coaR.data || []) {
      const j = (r as any).coa_jobs;
      if (j) bump(j.id, j.client_links?.client_name || "?", "COA Cleanup");
    }
    for (const r of reclassR.data || []) {
      const j = (r as any).reclass_jobs;
      if (j) bump(j.id, j.client_links?.client_name || "?", "Reclass");
    }
    for (const r of stripeR.data || []) {
      const j = (r as any).stripe_recon_jobs;
      if (j) bump(j.id, j.client_links?.client_name || "?", "Stripe Recon");
    }
    myPendingReview = {
      coa: coaR.data?.length || 0,
      reclass: reclassR.data?.length || 0,
      stripe: stripeR.data?.length || 0,
      total: (coaR.data?.length || 0) + (reclassR.data?.length || 0) + (stripeR.data?.length || 0),
      jobs: Array.from(byJob.values()),
    };
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const statCards = [
    { label: "Active Jobs", value: stats?.active_jobs ?? 0, color: "#2D7A75", icon: Zap },
    { label: "Completed This Week", value: stats?.completed_this_week ?? 0, color: "#10B981", icon: CheckCircle2 },
    { label: "Flagged for Lisa", value: stats?.flagged_for_lisa ?? 0, color: "#F59E0B", icon: Flag },
    {
      label: "Avg Duration",
      value: stats?.avg_duration_seconds ? `${Math.round(stats.avg_duration_seconds / 60)}m` : "—",
      color: "#0F1F2E",
      icon: TrendingUp,
    },
  ];

  return (
    <AppShell>
      <TopBar
        title="Dashboard"
        subtitle={`${today} — Welcome back`}
        actions={
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            <Plus size={16} />
            New Cleanup Job
          </Link>
        }
      />

      <div className="px-8 py-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {statCards.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="p-5 rounded-xl bg-white border border-gray-200">
                <div className="flex items-start justify-between mb-3">
                  <div
                    className="p-2 rounded-lg"
                    style={{ backgroundColor: `${s.color}15` }}
                  >
                    <Icon size={18} style={{ color: s.color }} />
                  </div>
                </div>
                <div className="text-2xl font-bold tracking-tight text-navy">{s.value}</div>
                <div className="text-sm mt-1 text-ink-slate">{s.label}</div>
              </div>
            );
          })}
        </div>

        {/* Awaiting senior review — only renders when there's something to show */}
        {myPendingReview.total > 0 && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 mb-6 overflow-hidden">
            <div className="px-5 py-4 border-b border-amber-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-amber-100">
                  <AlertCircle size={18} className="text-amber-600" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-navy">Your items awaiting senior review</h2>
                  <p className="text-xs text-ink-slate mt-0.5">
                    {myPendingReview.total} item{myPendingReview.total === 1 ? "" : "s"} flagged on your jobs — a senior bookkeeper will resolve these.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {myPendingReview.coa > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2 py-1 text-amber-800">
                    {myPendingReview.coa} COA
                  </span>
                )}
                {myPendingReview.reclass > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2 py-1 text-amber-800">
                    {myPendingReview.reclass} Reclass
                  </span>
                )}
                {myPendingReview.stripe > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2 py-1 text-amber-800">
                    {myPendingReview.stripe} Stripe
                  </span>
                )}
              </div>
            </div>
            <div className="bg-white">
              {myPendingReview.jobs.map((j, i) => (
                <div
                  key={i}
                  className="px-5 py-2.5 flex items-center justify-between text-sm"
                  style={{ borderBottom: i < myPendingReview.jobs.length - 1 ? "1px solid #F3F4F6" : "none" }}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-navy">{j.client_name}</span>
                    <span className="text-xs text-ink-slate">{j.source}</span>
                  </div>
                  <span className="text-xs font-semibold text-amber-700">
                    {j.count} pending
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Workflow guide */}
        <div className="rounded-xl bg-white border border-gray-200 mb-6 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-teal-lighter to-blue-50">
            <h2 className="text-base font-bold text-navy">The Ironbooks Cleanup Workflow</h2>
            <p className="text-xs text-ink-slate mt-0.5">
              Four sequential steps to take a painter's QBO from messy to clean. Each step hands off to the next.
            </p>
          </div>
          <div className="grid grid-cols-4 divide-x divide-gray-100">
            {[
              {
                num: 1, label: "COA Cleanup", icon: FilePlus2, href: "/jobs/new",
                desc: "Align chart of accounts to the Ironbooks master template",
                tag: "Required", tagColor: "#2D7A75",
              },
              {
                num: 2, label: "Reclassify", icon: Shuffle, href: "/reclass/new",
                desc: "AI categorizes every transaction against the new COA",
                tag: "Required", tagColor: "#2D7A75",
              },
              {
                num: 3, label: "Stripe Recon", icon: CreditCard, href: "/stripe-recon/new",
                desc: "Match Stripe deposits to invoices + split out fees & tax",
                tag: "If applicable", tagColor: "#7C3AED",
              },
              {
                num: 4, label: "Bank Rules", icon: Receipt, href: "/rules/new",
                desc: "Auto-generate rules so future transactions categorize themselves",
                tag: "Recommended", tagColor: "#0891B2",
              },
            ].map((s) => {
              const Icon = s.icon;
              return (
                <Link
                  key={s.num}
                  href={s.href}
                  className="p-4 hover:bg-teal-lighter transition-colors group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className="rounded-full flex items-center justify-center font-bold text-xs w-6 h-6 bg-gray-100 text-ink-slate group-hover:bg-teal group-hover:text-white transition-colors">
                      {s.num}
                    </div>
                    <Icon size={16} className="text-ink-slate group-hover:text-teal transition-colors" />
                    <span
                      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ml-auto"
                      style={{ backgroundColor: `${s.tagColor}15`, color: s.tagColor }}
                    >
                      {s.tag}
                    </span>
                  </div>
                  <div className="font-bold text-sm text-navy mb-1">{s.label}</div>
                  <div className="text-xs text-ink-slate leading-snug">{s.desc}</div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Active jobs */}
        <div className="rounded-xl bg-white border border-gray-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <h2 className="text-base font-bold text-navy">Active Jobs</h2>
            <Link href="/history" className="text-sm font-semibold flex items-center gap-1 text-teal">
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {!jobs || jobs.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm text-ink-slate mb-4">No active jobs yet.</p>
              <Link
                href="/jobs/new"
                className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:text-teal-dark"
              >
                Start your first cleanup <ArrowRight size={14} />
              </Link>
            </div>
          ) : (
            <div>
              {jobs.map((job, i) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}/review`}
                  className="flex items-center px-5 py-4 hover:bg-teal-lighter transition-colors"
                  style={{
                    borderBottom: i < jobs.length - 1 ? "1px solid #F1F5F9" : "none",
                  }}
                >
                  <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 mr-4 w-9 h-9 bg-teal-light text-teal">
                    {job.client_name?.charAt(0) || "?"}
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold text-sm text-navy">{job.client_name}</div>
                    <div className="text-xs mt-0.5 text-ink-slate">
                      {job.bookkeeper_name} • {job.jurisdiction} {job.state_province}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-teal-light text-teal capitalize">
                      {job.status?.replace("_", " ")}
                    </span>
                    {job.flagged_for_lisa && (
                      <Flag size={14} className="text-yellow-500" />
                    )}
                    <MoreVertical size={16} className="text-ink-light" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
