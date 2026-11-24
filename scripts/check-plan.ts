// Finished milestones leave docs/PLAN.md: a milestone whose status row says "merged" or "done"
// must not still have its "## <id> —" section here (it moves to docs/PLAN-done.md in the PR
// that finishes it; PLAN.md › Session protocol). Run: node scripts/check-plan.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FINISHED = /^(merged|done)\b/i;

/** Ids (M3, H7, …) of the Status table's rows whose status cell starts with merged or done. */
export function finishedMilestones(plan: string): string[] {
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => /^## Status\s*$/.test(l));
  if (start < 0) return [];
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0].replace(/:/g, ""))) continue;
    const id = cells[0].split(/\s+/)[0];
    if (id && FINISHED.test(cells[1])) ids.push(id);
  }
  return ids;
}

/** Finished milestones whose "## <id> —" section is still in the plan. */
export function staleSections(plan: string): string[] {
  const headings = new Set(
    plan
      .split("\n")
      .map((l) => /^## (\S+) —/.exec(l)?.[1])
      .filter((id): id is string => id !== undefined),
  );
  return finishedMilestones(plan).filter((id) => headings.has(id));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL("../docs/PLAN.md", import.meta.url));
  const stale = staleSections(readFileSync(path, "utf8"));
  if (stale.length > 0) {
    for (const id of stale) {
      console.error(`docs/PLAN.md: ${id} is finished but its "## ${id} —" section is still here.`);
    }
    console.error("Move each whole section, Notes included, to the end of docs/PLAN-done.md.");
    process.exit(1);
  }
  console.log("docs/PLAN.md: no finished milestone sections left.");
}
