import { redirect } from "next/navigation";

/**
 * /monthly-rec → /production.
 *
 * The Monthly Rec roster became the Production board (June 2026
 * restructure). The per-client close flow lives on in
 * app/production/rec-card.tsx, and the API routes are unchanged.
 */
export default function MonthlyRecRedirect() {
  redirect("/production");
}
