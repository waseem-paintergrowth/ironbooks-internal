/**
 * Admin impersonation — lets admin/lead view the client portal as a
 * specific client user, without signing out of their own session.
 *
 * Mechanism:
 *   - A signed-in admin clicks "View as client" → POST /api/admin/impersonate/start
 *     → server validates + sets httpOnly cookie `snap_impersonate_user_id`
 *     containing the target client user_id (with a 4h max-age)
 *   - On every server-side request, resolvePortalContext + middleware
 *     check for this cookie. When present AND the requester is admin/lead,
 *     they're treated as the target client user for portal data scoping.
 *   - Banner in the portal layout shows "Viewing as <client name>" with a
 *     prominent Stop button → POST /api/admin/impersonate/stop
 *
 * Hard rules:
 *   - Cookie only honored when the *actual* signed-in user is admin/lead.
 *     If their role is revoked mid-session, the cookie becomes inert.
 *   - Cookie is httpOnly so JavaScript can't read or set it.
 *   - Audit log entries on start AND stop with both identities.
 *   - AI rate-limit and message tally are skipped when impersonating —
 *     admin testing shouldn't burn the client's 50/day quota.
 */
import { cookies } from "next/headers";

export const IMPERSONATION_COOKIE = "snap_impersonate_user_id";
export const IMPERSONATION_MAX_AGE_SECONDS = 60 * 60 * 4; // 4 hours

/**
 * Read the impersonation cookie. Returns the target user_id or null.
 * Server-only — uses next/headers. Safe to call from server components,
 * API routes, and middleware (with the appropriate request-cookies adapter).
 */
export async function readImpersonationCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(IMPERSONATION_COOKIE)?.value || null;
  } catch {
    return null;
  }
}

/**
 * Set the impersonation cookie. Only the /api/admin/impersonate/start
 * route should call this — direct callers bypass the role/target checks.
 */
export async function writeImpersonationCookie(targetUserId: string): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, targetUserId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: IMPERSONATION_MAX_AGE_SECONDS,
  });
}

/**
 * Clear the impersonation cookie. Called by /api/admin/impersonate/stop
 * and also as a safety net any time we detect an inert cookie (target
 * deleted, admin role revoked, etc.).
 */
export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATION_COOKIE);
}
