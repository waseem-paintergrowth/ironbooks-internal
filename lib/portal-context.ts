/**
 * Portal context helper — single source of truth for "which client is the
 * currently-logged-in portal user looking at, and what's their QBO access?"
 *
 * Every portal data fetcher calls resolvePortalContext() at the top. If the
 * user isn't a client, doesn't have an active mapping, or the mapped
 * client_link has no QBO connection, this throws — caught upstream by the
 * page-level error boundaries.
 *
 * This is defense-in-depth on top of the middleware role gate: even if a
 * client somehow lands on a portal API route, they can only ever access
 * their own client's QBO data because the access token is resolved
 * server-side from their user_id, not from any request parameter.
 */
import { createServerSupabase, createServiceSupabase } from "./supabase";
import { getValidToken } from "./qbo";
import { readImpersonationCookie, clearImpersonationCookie } from "./impersonation";

export interface PortalContext {
  userId: string;
  userEmail: string;
  userFullName: string;
  clientLinkId: string;
  clientName: string;
  qboRealmId: string;
  accessToken: string;
  /** True when an admin is viewing the portal as this client. Used by the
   *  layout to render the impersonation banner, and by the AI route to
   *  skip rate-limit increments. */
  impersonating: boolean;
  /** Set only when impersonating — the real admin's identity (for the banner
   *  + audit log). */
  realUserId?: string;
  realUserName?: string;
}

export class PortalAccessError extends Error {
  constructor(message: string, public code: "no_session" | "not_client" | "no_mapping" | "no_qbo" | "fetch_failed") {
    super(message);
    this.name = "PortalAccessError";
  }
}

/**
 * Resolve the portal user → client_link → QBO access token in one shot.
 * Throws PortalAccessError if any step fails; callers should catch it and
 * render an appropriate UI state.
 *
 * Uses the service-role client for the DB lookups so we don't depend on
 * per-row RLS policies — those will land later as part of the rollout but
 * this layer is the security boundary regardless.
 */
export async function resolvePortalContext(): Promise<PortalContext> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new PortalAccessError("Not signed in", "no_session");
  }

  const service = createServiceSupabase();

  const { data: profile } = await service
    .from("users")
    .select("role, email, full_name, is_active")
    .eq("id", user.id)
    .single();
  const actualRole = (profile as any)?.role;
  const isAdmin = actualRole === "admin" || actualRole === "lead";

  // ─── Impersonation path ───
  // An admin/lead with the impersonation cookie set is treated as the
  // target client user for portal data scoping. Cookie is inert if the
  // signed-in user isn't admin/lead — defense against a leaked cookie.
  let effectiveUserId = user.id;
  let impersonating = false;
  let realUserId: string | undefined;
  let realUserName: string | undefined;

  if (isAdmin) {
    const targetUserId = await readImpersonationCookie();
    if (targetUserId) {
      // Verify the target is a real client user with an active mapping.
      // If not, the cookie is stale — clear it and fall through to the
      // normal admin flow (which will fail not_client and bounce back).
      const { data: target } = await service
        .from("users")
        .select("id, role, is_active, full_name")
        .eq("id", targetUserId)
        .single();
      if ((target as any)?.role === "client" && (target as any)?.is_active !== false) {
        effectiveUserId = targetUserId;
        impersonating = true;
        realUserId = user.id;
        realUserName = (profile as any)?.full_name || user.email || "Admin";
      } else {
        await clearImpersonationCookie();
      }
    }
  }

  // ─── Normal role check (skipped when impersonating because we've already
  //     verified the target is a client) ───
  if (!impersonating) {
    if (actualRole !== "client") {
      throw new PortalAccessError("Not a portal user", "not_client");
    }
    if ((profile as any)?.is_active === false) {
      throw new PortalAccessError("Account is disabled", "not_client");
    }
  }

  // Resolve the (effective) user's client mapping
  const { data: mapping } = await service
    .from("client_users" as any)
    .select("client_link_id, active")
    .eq("user_id", effectiveUserId)
    .eq("active", true)
    .maybeSingle();
  if (!mapping || !(mapping as any).client_link_id) {
    throw new PortalAccessError("Portal access not provisioned", "no_mapping");
  }
  const clientLinkId = (mapping as any).client_link_id as string;

  // Pull the (effective) client + portal user metadata for the banner
  const { data: targetProfile } = impersonating
    ? await service.from("users").select("email, full_name").eq("id", effectiveUserId).single()
    : { data: profile as any };

  // Pull the client details + ensure QBO is connected
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) {
    throw new PortalAccessError("Client not found", "no_mapping");
  }
  if ((client as any).is_active === false) {
    throw new PortalAccessError("Client is inactive", "no_mapping");
  }
  if (!(client as any).qbo_realm_id) {
    throw new PortalAccessError("QBO not connected for this client", "no_qbo");
  }

  // Get a fresh QBO access token. getValidToken handles refresh internally.
  let accessToken: string;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
  } catch (err: any) {
    throw new PortalAccessError(
      `QBO authorization failed: ${err?.message || "unknown"}`,
      "no_qbo"
    );
  }

  return {
    userId: effectiveUserId,
    userEmail: (targetProfile as any)?.email || "",
    userFullName: (targetProfile as any)?.full_name || "",
    clientLinkId,
    clientName: (client as any).client_name || "Your Business",
    qboRealmId: (client as any).qbo_realm_id as string,
    accessToken,
    impersonating,
    realUserId,
    realUserName,
  };
}

/**
 * Helper for the "not-yet-set-up" friendly states. Returns null if the
 * context resolves cleanly, or a structured error so pages can render
 * a useful message without crashing.
 */
export async function tryResolvePortalContext(): Promise<
  | { ok: true; ctx: PortalContext }
  | { ok: false; code: PortalAccessError["code"]; message: string }
> {
  try {
    const ctx = await resolvePortalContext();
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: "fetch_failed", message: (err as Error).message };
  }
}
