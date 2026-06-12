import { redirect } from "next/navigation";

/**
 * /kanban → /cleanup.
 *
 * The two kanban boards were replaced by the simplified Cleanup and
 * Production sections (June 2026 restructure). The onboarding kanban API
 * (/api/kanban/onboarding) still powers the Cleanup board's columns.
 */
export default function KanbanRedirect() {
  redirect("/cleanup");
}
