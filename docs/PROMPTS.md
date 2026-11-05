# Bamboo — Session prompts

Opening messages for Claude Code sessions on the Mac (run from the `bamboo` checkout on `main`).

## Orchestrator (recommended)

One long-lived session that runs the whole plan and dispatches a fresh session per milestone:

> You are the orchestrator for Bamboo. Read CLAUDE.md and docs/PLAN.md in full, then follow
> docs/PLAN.md › Orchestrator protocol. Dispatch each milestone to a subagent in its own git
> worktree; never implement a milestone yourself. Start by telling me the status and which
> milestones are ready, and ask me for any inputs they need. Ask me before merging any PR.

To restart it later (new context), send the same prompt. The status table and Notes in
`docs/PLAN.md` carry the state.

## One milestone, by hand

If you'd rather start each milestone yourself, use one session per milestone:

> You are the milestone session for M<N> of Bamboo. Read CLAUDE.md, then follow docs/PLAN.md ›
> Session protocol for M<N> exactly. Ask me for any inputs or account steps you need before you
> rely on them. Finish with the PR URL, acceptance results, deviations recorded in Notes, and every
> manual step I must take.

For M0, add: *"Here's a Gemini share link to test with: <link>."*

## Plan update (after a surprise)

> Read CLAUDE.md and docs/PLAN.md. While building M<N> we found: <what happened>. Propose the
> changes to later milestones, DESIGN.md and PRD.md. Explain them to me in plain words, and once I
> agree, open a `claude/plan-update-<topic>` PR. Don't drop or add features without asking me.

## Extraction and ranking review (after a few weeks of use)

> Read CLAUDE.md and docs/DESIGN.md §4.6, §5.3 and §7. Review extraction and ranking quality from
> the prod data: Stats numbers, plus samples of dropped phrases and dropped extraction items. Rank
> the problems and propose prompt or weight changes with evidence, quoting no conversation
> content in the PR. Wait for my approval before implementing.
