/**
 * Ask the AI — chat interface mockup for the financial-literacy assistant.
 *
 * Pre-populated with a sample conversation so reviewers can see the tone
 * and depth. Real version: streaming Claude responses with full QBO context.
 */
import { Sparkles, Send, ThumbsUp, ThumbsDown, Copy } from "lucide-react";

export default function AskAiMockup() {
  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-200px)]">
      <div className="flex-shrink-0">
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Your AI bookkeeper</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Ask anything about your finances</h1>
        <div className="text-sm text-ink-slate mt-1">
          Powered by Claude · Knows your live QBO data · Trained to explain things in plain English
        </div>
      </div>

      {/* Suggested starter questions */}
      <div className="flex-shrink-0 flex flex-wrap gap-2">
        <StarterPill text="Why did costs go up this month?" />
        <StarterPill text="Can I afford to hire another painter?" />
        <StarterPill text="What's a healthy profit margin for my business?" />
        <StarterPill text="How much should I set aside for taxes?" />
        <StarterPill text="Explain my balance sheet like I'm 5" />
      </div>

      {/* Chat history */}
      <div className="flex-1 overflow-y-auto space-y-4 bg-white border border-slate-200 rounded-2xl p-5">
        <UserBubble>
          Why did my profit grow so much this month?
        </UserBubble>

        <AiBubble>
          <p>Great question — May was a strong month for two reasons:</p>
          <ol className="list-decimal ml-5 mt-2 space-y-1">
            <li>
              <strong>Three big commercial jobs closed mid-month</strong> (Hudson Construction $5.2K,
              Pinnacle Builders $5K, Riverside HOA $4.8K). Commercial jobs typically have higher
              margins than residential — about 32% vs your residential average of 24%.
            </li>
            <li>
              <strong>You spent less on subcontractors</strong> than April ($22.4K vs $28.1K). It looks
              like more work was done by your in-house painters this month, which is more profitable
              per dollar of revenue.
            </li>
          </ol>
          <p className="mt-2">
            Your overhead stayed roughly flat at $17K, so all that extra margin dropped to the bottom
            line. <strong>Net: $22,100 profit vs $11,900 in April</strong> — almost doubled.
          </p>
        </AiBubble>

        <UserBubble>Should I hire another full-time painter then?</UserBubble>

        <AiBubble>
          <p>Maybe — let's look at the math.</p>
          <p className="mt-2">
            A full-time painter costs you roughly <strong>$58K/year</strong> all-in (wages + payroll
            taxes + workers comp + benefits). To justify that cost, they need to generate about{" "}
            <strong>$130K-150K of revenue per year</strong> at your typical 24% direct-job margin
            (residential).
          </p>
          <p className="mt-2">
            <strong>What I'd want to know first:</strong>
          </p>
          <ul className="list-disc ml-5 mt-1 space-y-1">
            <li>Are you turning down jobs because you can't staff them? (If yes — easy yes.)</li>
            <li>Is your subcontractor spend creeping up over time? (You've spent $22K/mo on subs lately — that's $264K/year. Even half that volume done in-house could justify a hire.)</li>
            <li>Do you have a clear pipeline of work for the next 90 days?</li>
          </ul>
          <p className="mt-2">
            Want me to do a hire-vs-keep-subcontracting breakdown using your actual job history? I can
            run the numbers from QBO.
          </p>
        </AiBubble>

        <div className="flex items-center gap-2 ml-12 -mt-2">
          <button className="text-[11px] text-ink-light hover:text-ink-slate inline-flex items-center gap-1">
            <ThumbsUp size={11} /> Helpful
          </button>
          <button className="text-[11px] text-ink-light hover:text-ink-slate inline-flex items-center gap-1">
            <ThumbsDown size={11} /> Not quite
          </button>
          <button className="text-[11px] text-ink-light hover:text-ink-slate inline-flex items-center gap-1">
            <Copy size={11} /> Copy
          </button>
        </div>
      </div>

      {/* Input box */}
      <div className="flex-shrink-0 bg-white border-2 border-slate-200 rounded-2xl p-3 focus-within:border-teal/50">
        <textarea
          placeholder="Ask anything — 'Can I afford this?', 'Explain my taxes', 'Why is this number weird?'"
          className="w-full resize-none outline-none text-sm text-navy placeholder:text-ink-light min-h-[60px]"
        />
        <div className="flex items-center justify-between mt-2">
          <div className="text-[11px] text-ink-light">
            The AI has access to your live QBO data and the last 90 days of transactions. It
            won't give legal or tax advice — talk to your CPA for that.
          </div>
          <button className="px-3 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark inline-flex items-center gap-1.5">
            <Send size={12} /> Send
          </button>
        </div>
      </div>
    </div>
  );
}

function StarterPill({ text }: { text: string }) {
  return (
    <button className="text-xs px-3 py-1.5 bg-white border border-slate-200 rounded-full text-ink-slate hover:bg-teal/5 hover:border-teal/40 hover:text-teal-dark">
      {text}
    </button>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="bg-teal text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm">
        {children}
      </div>
    </div>
  );
}

function AiBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-teal/10 flex items-center justify-center flex-shrink-0">
        <Sparkles size={14} className="text-teal-dark" />
      </div>
      <div className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-navy max-w-[85%] leading-relaxed">
        {children}
      </div>
    </div>
  );
}
