import type { PublicSchool } from "@/lib/session";

/**
 * What the portal can honestly say about a DPIA.
 *
 * /legal/privacy §5 used to tell every reader that the school relies on "a
 * filed Data Protection Impact Assessment (DPIA) with the Nigeria Data
 * Protection Commission", and /legal/retention repeated it. Nothing in this
 * system had ever recorded one. The claim was published to parents, on the
 * school's behalf, by software that had no idea whether it was true — and if
 * the NDPC asked, the school would be the one explaining its own policy.
 *
 * Same treatment as the DPO address: render what the school actually has,
 * and when there is nothing, say so where the reader can see it instead of
 * asserting the comfortable version.
 */
export default function DpiaStatement({ school }: { school: PublicSchool }) {
  const ref = school.dpia_reference?.trim();
  const done = school.dpia_completed_at?.trim();

  if (ref) {
    return (
      <p>
        {school.name} has completed a Data Protection Impact Assessment
        {done ? ` on ${new Date(`${done}T12:00:00Z`).toLocaleDateString(undefined,
          { day: "numeric", month: "long", year: "numeric" })}` : ""}
        , reference <strong>{ref}</strong>. Where the portal is hosted outside Nigeria, transfers
        rely on Standard Contractual Clauses.
      </p>
    );
  }

  return (
    <p style={{ border: "1px solid #b45309", background: "#fffbeb", padding: 12, borderRadius: 6 }}>
      <strong>No Data Protection Impact Assessment has been recorded for this portal.</strong>{" "}
      Processing pupils&rsquo; records at this scale normally requires one under NDPA §28, and the
      school may have completed one outside this system — but the portal cannot confirm it, so it
      will not claim it. An administrator can record the DPIA reference under{" "}
      <strong>School → Compliance</strong>. Where the portal is hosted outside Nigeria, transfers
      rely on Standard Contractual Clauses.
    </p>
  );
}
