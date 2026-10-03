import { redirect } from "next/navigation";
import { checkSession, ROLE_HOME } from "@/lib/session";
import NotificationPrefsForm from "./notification-prefs-form";

export const metadata = { title: "Email preferences — School Portal" };

/**
 * The page every bulk email has been promising.
 *
 * `List-Unsubscribe: <ORIGIN/account/notifications>` went out on every
 * absence alert, grade notice, message notification and daily digest — and
 * the URL 404'd. A recipient who followed it got an error page while the
 * emails kept arriving.
 */
export default async function NotificationPreferencesPage() {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  return (
    <div className="container" style={{ maxWidth: 640, paddingTop: 32 }}>
      <h1>Email preferences</h1>
      <p className="muted">
        Choose which school emails you receive. Changes take effect immediately —
        anything already queued for sending will still arrive.
      </p>
      <NotificationPrefsForm home={ROLE_HOME[check.session.activeRole] ?? "/student"} />
    </div>
  );
}
