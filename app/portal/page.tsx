import { Sparkles } from "lucide-react";

/**
 * Portal Overview — placeholder for Day 1.
 *
 * The real version (Days 3-5) will pull live QBO data + a Claude-generated
 * narrative. For now this just confirms the auth + routing plumbing works
 * end-to-end without showing fake "$84,200" numbers that might mislead a
 * client who lands here during the build window.
 */
export const dynamic = "force-dynamic";

export default function PortalOverview() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">
          Welcome
        </div>
        <h1 className="text-3xl font-bold text-navy mt-1">Your portal is almost ready</h1>
        <div className="text-sm text-ink-slate mt-1">
          We're finishing the connections to your books — full dashboard launching soon.
        </div>
      </div>

      <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-6">
        <div className="flex items-start gap-3 mb-2">
          <Sparkles size={20} className="text-teal-dark mt-0.5" />
          <div>
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">
              What's coming
            </div>
            <h2 className="text-lg font-bold text-navy mt-1">
              Live financials, AI Q&A, and a video library
            </h2>
          </div>
        </div>
        <p className="text-sm text-navy/80 leading-relaxed">
          You'll see your Profit & Loss, Balance Sheet, who owes you money, what you owe — all in
          plain English. Plus an AI assistant trained on your books for any questions, and short
          training videos to help you read your financials confidently.
        </p>
      </div>

      <div className="text-xs text-ink-light text-center pt-2">
        If you have questions in the meantime, reach out to your Ironbooks bookkeeper directly.
      </div>
    </div>
  );
}
