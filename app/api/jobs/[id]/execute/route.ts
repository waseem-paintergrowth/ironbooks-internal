import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { executeJob } from "@/lib/executor";
import { NextResponse } from "next/server";
import { after } from "next/server";

/**
 * POST /api/jobs/[id]/execute
 *
 * Kicks off the execution and returns immediately.
 * Actual work runs in background via Next.js `after()`.
 * Frontend polls /api/jobs/[id]/status for progress.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify job exists and is in a valid state to execute
  const service = createServiceSupabase();
  const { data: job } = await service
    .from("coa_jobs")
    .select("status, bookkeeper_id")
    .eq("id", jobId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status === "executing") {
    return NextResponse.json({ message: "Already executing", started: false });
  }

  if (job.status === "complete") {
    return NextResponse.json({ message: "Already complete", started: false });
  }

  // Mark as starting (so the status page knows execution has begun)
  await service
    .from("coa_jobs")
    .update({
      status: "executing",
      execution_started_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  // Schedule the actual work to run after response is sent
  after(async () => {
    try {
      await executeJob(jobId);
    } catch (err: any) {
      console.error(`Background execution failed for job ${jobId}:`, err);
    }
  });

  return NextResponse.json({ started: true, job_id: jobId });
}

// Long-running execution support. Vercel Pro caps Node serverless functions
// at 800s. We use 800 so legitimately big merges (sub-500-line) and many
// small actions in one execute pass have room to finish. Oversized merges
// (>500 lines) are pre-flighted and routed to manual cleanup so the timeout
// is a safety net, not a hot path.
export const maxDuration = 800;
