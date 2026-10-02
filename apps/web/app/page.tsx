import { redirect } from "next/navigation";
import { checkSession, ROLE_HOME } from "@/lib/session";

export default async function Home() {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  if (check.session.mustChangePassword) redirect("/change"); // review-6 #3
  redirect(ROLE_HOME[check.session.activeRole] ?? "/student");
}
