"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Flag } from "lucide-react";

/**
 * Final "close the loop" action for a client cleanup cycle. Lives on the
 * stripe-recon review page (the canonical last step). When clicked, marks
 * the client_links row complete with date-range breadcrumbs so the PDF
 * report can be re-pulled later from the Completed Accounts table.
 *
 * Use case: the bookkeeper just finished the recon (either matched +
 * executed, or acknowledged because AR matching wasn't possible) and is
 * ready to move on. One click here moves the client out of the active
 * queue and onto the completed list.
 */
export function MarkCleanupCompleteButton({
  clientLinkId,
  clientName,
  defaultRangeStart,
  defaultRangeEnd,
  /** Variant changes the visual weight — "primary" is the green CTA after
   *  the recon flow finishes; "secondary" is a quieter button shown
   *  alongside other actions (e.g. the unmatched panel). */
  variant = "primary",
}: {
  clientLinkId: string;
  clientName: string;
  defaultRangeStart?: string | null;
  defaultRangeEnd?: string | null;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  async function handleMarkComplete() {
    if (!confirm(
      `Mark ${clientName}'s cleanup as complete?\n\n` +
      `• The client will move to the Completed Accounts list below the main grid.\n` +
      `• The PDF cleanup report will remain available to download.\n` +
      `• You can reopen the cleanup any time if more work comes up.`
    )) return;

    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/complete-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          range_start: defaultRangeStart || undefined,
          range_end: defaultRangeEnd || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push("/clients");
    } catch (e: any) {
      setError(e.message || "Failed to mark complete");
      setSubmitting(false);
    }
  }

  const isPrimary = variant === "primary";

  return (
    <div className={isPrimary ? "rounded-xl bg-green-50 border border-green-200 p-4" : ""}>
      {isPrimary && (
        <div className="flex items-start gap-2 mb-3">
          <Flag className="text-green-700 flex-shrink-0 mt-0.5" size={18} />
          <div className="text-sm">
            <div className="font-semibold text-green-900">
              Ready to close out {clientName}?
            </div>
            <div className="text-xs text-green-800 mt-0.5">
              Mark the cleanup complete to move this client to the Completed
              Accounts list. The PDF report stays available, and you can
              reopen any time.
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="mb-2 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}
      <button
        onClick={handleMarkComplete}
        disabled={submitting}
        className={
          isPrimary
            ? "w-full inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            : "w-full inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-50 disabled:opacity-60 border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
        }
      >
        {submitting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <CheckCircle2 size={16} />
        )}
        {submitting ? "Marking complete..." : `Mark ${clientName}'s cleanup complete`}
      </button>
    </div>
  );
}
