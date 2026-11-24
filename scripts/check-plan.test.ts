import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { finishedMilestones, staleSections } from "./check-plan.ts";

const plan = (rows: string, sections = "") => `# Plan

## Status

| Milestone | Status | PR |
|---|---|---|
${rows}

Pointer text.
${sections}`;

test("a finished milestone whose section is still present fails", () => {
  const md = plan(
    "| M3 Capture | merged | #6 |\n| H7 Backfill | done | #50 |",
    "\n## M3 — Capture\n\nNotes.\n\n## H7 — Backfill\n",
  );
  assert.deepEqual(staleSections(md), ["M3", "H7"]);
});

test("a finished milestone that moved passes", () => {
  assert.deepEqual(staleSections(plan("| M3 Capture | merged | #6 |")), []);
});

test("an in-progress milestone with its section passes", () => {
  const md = plan(
    "| M7 Next | in review | #80 |\n| M8 Later | not started | |",
    "\n## M7 — Next\n\n## M8 — Later\n",
  );
  assert.deepEqual(finishedMilestones(md), []);
  assert.deepEqual(staleSections(md), []);
});

test("rows without a section are ignored, and only the Status table counts", () => {
  const md = `## Other\n\n| M1 x | merged | |\n\n${plan("| M2 y | merged | |")}\n## M1 — x\n`;
  assert.deepEqual(finishedMilestones(md), ["M2"]);
  assert.deepEqual(staleSections(md), []);
});

test("docs/PLAN.md has no finished milestone sections", () => {
  const path = fileURLToPath(new URL("../docs/PLAN.md", import.meta.url));
  const md = readFileSync(path, "utf8");
  assert.ok(finishedMilestones(md).length > 0, "the Status table should parse");
  assert.deepEqual(staleSections(md), []);
});
