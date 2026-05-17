import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import crypto from "crypto";

/**
 * POST /api/stripe/webhook
 *
 * Stripe Connect webhook receiver. The endpoint we care about is
 * `account.application.deauthorized` — fired when a connected client clicks
 * "Disconnect" on Ironbooks inside their Stripe Dashboard. Without handling
 * this, our stored access_token quietly stops working and the bookkeeper
 * doesn't notice until a reconciliation run fails with 401.
 *
 * Signature verification is mandatory — Stripe signs every event with
 * STRIPE_WEBHOOK_SECRET (set in Vercel after creating the endpoint in
 * Stripe Dashboard → Developers → Webhooks).
 *
 * Configuration on the Stripe side:
 *   URL:       https://internal.ironbooks.com/api/stripe/webhook
 *   Events:    account.application.deauthorized
 *   API type:  Connect (NOT Account) — Connect events fire from the
 *              platform; Account-mode would only fire from the platform's
 *              own account.
 */

// Disable Next.js body parsing — we need the raw bytes for signature check
export const config = {
  api: { bodyParser: false },
};

function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  // Stripe-Signature: t=<timestamp>,v1=<sig>,v1=<sig>...
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const tEntry = parts.find((p) => p.startsWith("t="));
  const v1Entries = parts.filter((p) => p.startsWith("v1="));
  if (!tEntry || v1Entries.length === 0) return false;

  const timestamp = tEntry.slice(2);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;

  // Replay protection
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  // Constant-time comparison against each provided v1 signature
  for (const v of v1Entries) {
    const provided = v.slice(3);
    if (
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    ) {
      return true;
    }
  }
  return false;
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // Read raw body bytes for signature verification
  const payload = await request.text();
  if (!verifyStripeSignature(payload, signature, secret)) {
    console.warn("[stripe/webhook] Signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // We only care about account.application.deauthorized for now. Other
  // events return 200 so Stripe doesn't keep retrying them.
  if (event.type !== "account.application.deauthorized") {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  // The connected account id sits at the top-level `account` field for
  // Connect events (not at data.object.id like normal events).
  const stripeAccountId: string | undefined = event.account;
  if (!stripeAccountId) {
    console.warn("[stripe/webhook] deauthorized event with no account field");
    return NextResponse.json({ ok: true, no_op: "no account id" });
  }

  const service = createServiceSupabase();

  // Find the client_link by stripe_account_id
  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();

  if (!clientLink) {
    // Already disconnected or unknown account — still return 200 to avoid retries
    console.warn(`[stripe/webhook] deauthorized for unknown account ${stripeAccountId}`);
    return NextResponse.json({ ok: true, no_match: stripeAccountId });
  }

  // Clear the connection state. Status flips to 'not_set' (same as manual
  // disconnect via our sidebar modal). The bookkeeper can send a fresh link
  // if they want to reconnect.
  await service
    .from("client_links")
    .update({
      stripe_account_id: null,
      stripe_access_token: null,
      stripe_refresh_token: null,
      stripe_connected_at: null,
      stripe_connection_status: "not_set",
      stripe_livemode: null,
    } as any)
    .eq("id", clientLink.id);

  await service.from("audit_log").insert({
    event_type: "stripe_oauth_revoked_by_client",
    request_payload: {
      message: `Client revoked Stripe access for ${clientLink.client_name}`,
      client_link_id: clientLink.id,
      stripe_account_id: stripeAccountId,
      stripe_event_id: event.id,
      livemode: event.livemode,
    } as any,
  } as any);

  return NextResponse.json({ ok: true, revoked: clientLink.id });
}
