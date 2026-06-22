/**
 * "Work complete" notifications — the SNAP-native replacement for DoubleHQ's
 * task-board posts. When a deliverable milestone finishes (COA cleanup,
 * month-end close), this records an audit_log row AND emails the firm's
 * leads/admins so a manager knows the work is done without living in Double.
 *
 * Best-effort: a DB or email hiccup never blocks the job that just finished.
 * Recipients = active admin+lead users, OR WORK_COMPLETE_NOTIFY_EMAIL if set
 * (route everything to one inbox / a shared alias).
 */
import { sendResendEmail } from "./client-comms";

export async function notifyWorkComplete(
  service: any,
  params: {
    kind: string;          // e.g. "COA cleanup", "Month-end close"
    clientLinkId: string;
    summary: string;       // one-line detail, e.g. "182 renamed, 14 created"
    actorName?: string | null;
  }
): Promise<void> {
  // Resolve the client name (callers only have the id).
  let clientName = "a client";
  try {
    const { data } = await service
      .from("client_links")
      .select("client_name")
      .eq("id", params.clientLinkId)
      .single();
    if (data?.client_name) clientName = data.client_name;
  } catch {
    /* name is cosmetic — fall back */
  }

  // 1. Audit trail (queryable record of every completion).
  try {
    await service.from("audit_log").insert({
      event_type: "work_complete",
      request_payload: {
        kind: params.kind,
        client_link_id: params.clientLinkId,
        client_name: clientName,
        summary: params.summary,
        actor: params.actorName || null,
      } as any,
    });
  } catch {
    /* ignore */
  }

  // 2. Email the leads (best-effort).
  try {
    let emails: string[] = [];
    const override = (process.env.WORK_COMPLETE_NOTIFY_EMAIL || "").trim();
    if (override) {
      emails = override.split(",").map((e) => e.trim()).filter(Boolean);
    } else {
      const { data: leads } = await service
        .from("users")
        .select("email")
        .in("role", ["admin", "lead"])
        .eq("is_active", true);
      emails = ((leads as any[]) || []).map((l) => l.email).filter(Boolean);
    }
    if (emails.length === 0) return;

    const by = params.actorName ? ` by ${params.actorName}` : "";
    const text = [
      `${params.kind} complete — ${clientName}${by}.`,
      ``,
      params.summary,
      ``,
      `View the client in SNAP: https://snap.ironbooks.com/clients`,
    ].join("\n");
    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F1F2E;">
  <p style="font-size:15px;margin:0 0 6px;"><strong>✅ ${esc(params.kind)} complete</strong> — ${esc(clientName)}${by ? ` <span style="color:#475569;">${esc(by.trim())}</span>` : ""}</p>
  <p style="font-size:14px;color:#33414E;margin:0 0 14px;">${esc(params.summary)}</p>
  <a href="https://snap.ironbooks.com/clients" style="display:inline-block;background:#1A9B8F;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:9px 18px;border-radius:8px;">Open in SNAP</a>
</div>`;

    await sendResendEmail({
      to: emails,
      replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
      subject: `✅ ${params.kind} complete — ${clientName}`,
      text,
      html,
    });
  } catch {
    /* ignore — completion already recorded in audit_log */
  }
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
