# Bamboo — Build Plan

> Living document. Each milestone is executed by **one fresh Claude Code session** producing
> **one PR**. Sessions read only what their milestone lists. When a milestone deviates from this
> plan or from DESIGN.md, record it in the milestone's **Notes** and update DESIGN.md in the same
> PR.

## Session protocol

1. Read `CLAUDE.md`, this file's *Session protocol*, and **your milestone only**, then the
   DESIGN/PRD sections it lists.
2. Branch from the latest `main`: `claude/m<N>-<slug>` (Hybrid milestones: `claude/h<N>-<slug>`).
3. Build to the acceptance criteria. Run every acceptance command locally; all must pass.
4. Update the status table below (→ `in review`) and your milestone's **Notes**: versions chosen,
   deviations, and anything later milestones need to know.
5. Open a PR titled `M<N>: <title>` (or `H<N>: <title>`). The body lists the acceptance commands and their results,
   plus any manual steps Will must do (accounts, env vars, phone checks).
6. Drive the PR to green and mergeable: on every check, look at mergeability before CI (a PR that
   conflicts with `main` gets no CI).
7. **The PR that finishes your milestone moves it out.** In that same PR, move the milestone's
   whole section, Notes included, from this file to the end of [PLAN-done.md](PLAN-done.md), and
   mark its status row `merged`. CI fails while a `merged` or `done` row still has its
   `## <id> —` section here (`pnpm check:plan`, part of `pnpm test`).
8. Don't edit files owned by another milestone except where your milestone says so. If you must,
   call it out in the PR.
9. Never commit, quote or paste Will's real conversations (CLAUDE.md *Privacy*). Report counts only.

## Orchestrator protocol

Will can run the plan through one long-lived **orchestrator** session on the Mac, which dispatches
a fresh **milestone session** for each milestone (for example, a subagent in its own git
worktree). The orchestrator:

1. **Plans the next step.** It reads `CLAUDE.md` and this file. It opens a merged milestone's Notes in
   [PLAN-done.md](PLAN-done.md) only when a ready milestone depends on it. A milestone is *ready* when everything it depends on is merged. It tells Will what it
   intends to dispatch next, and why.
2. **Gathers Will's inputs first.** Milestone sessions can't ask Will anything, so the orchestrator
   collects what they need before dispatching. M0 needs a share link. M1 needs the accounts listed
   in its manual steps, which can also be done after the PR.
3. **Dispatches** each ready milestone with this prompt:
   *"You are the milestone session for M<N> of Bamboo. Follow docs/PLAN.md › Session protocol
   for M<N> exactly. Inputs from Will: <…>. When done, report: the PR URL, the acceptance results,
   the deviations you recorded in Notes, and every manual step Will must take."* Independent ready
   milestones (M0 ∥ M1; M4 ∥ M5) may run in parallel, each in its own worktree.
   Dispatch with **`model: "sonnet"`** and **`effort: "medium"`** (`create_session` in the cloud;
   this is the standing instruction those parameters require). Use `model: "opus"`, still at
   medium effort, only for a milestone whose core is new design: a schema or API contract, a
   prompt or extraction schema, the pinyin merge, scheduling, or a backfill on production data.
   Say which you chose and why.
4. **Reviews** each result:
   - reads the PR diff and Notes;
   - checks it against the milestone's acceptance and CLAUDE.md rules (privacy above all);
   - sends the milestone session back to fix anything missing.
5. **Propagates changes.** If a milestone deviated, or found something that changes later
   milestones (for example, M0 finds share links unreadable), the orchestrator updates the
   downstream milestones' sections, DESIGN.md and PRD.md in a small `claude/plan-update-<topic>`
   PR. It lists those changes to Will in plain words. It never quietly drops scope; dropping or
   adding a feature is Will's call.
6. **Hands over to Will** for anything outside the repo: account setup, env vars, phone checks,
   and anything a milestone marks as Will's call. **Merging follows CLAUDE.md › *Merge when
   green*:** a PR that is mergeable, with every required check passed and no unresolved review
   thread, is merged without asking, unless its milestone (or Will) says he reviews it first.
   Anything that needs `sudo` or touches production is still asked first.
7. **Keeps the status table current** (a finished milestone's section leaves this file in its
   own PR, *Session protocol* step 7), then loops back to step 1 until M6 is merged. At the end it
   summarizes what was built, what changed from the plan, and the open ROADMAP candidates. The
   same loop ran the *Hybrid* milestones (H1–H7, now in PLAN-done.md); their sessions
   branched as `claude/h<N>-<slug>` and titled PRs `H<N>: <title>`.

Restart the orchestrator after each merge, or once its context passes ~200k tokens: end with a
one-paragraph status and the prompt to start the next one. Everything it needs is in this file (the
status table and Notes) and the PRs. Don't answer follow-up questions in a grown orchestrator;
each reply there resends its whole context.

## Dependency graph

```
M0 (share-link spike, on the Mac) ───────────────────────────┐
M1 ─▶ M2 ─▶ M3 ─┬─▶ M4 (worker)          ─┬─▶ M6 (reminder & stats)
                └─▶ M5 (Discord intake) ◀─┘ (M5 uses M0's findings)
```

M0 and M1 can run in parallel. M4 and M5 can run in parallel once M3 is merged; both are
clients of M3's API. **M2 is usable** with hand-added phrases; **M5 is when Bamboo becomes
genuinely useful** (share a conversation, get a deck).

Hybrid (Gemini-backed; DESIGN §5.5, §10 #74–#83), after the docs PR that records the decisions:

```
docs ─┬─▶ H1 (pinyin a) ──┐
      ├─▶ H3 (card back) ─┴─▶ H4 (worker on Gemini) ─┬─▶ H5 (tutor capture) ──┬─▶ H7 (backfill)
      │                                              └─▶ H6 (re-run; also H3) ─┤
      └─▶ H2 (estimate → Will chooses → new-card policy) ─────────────────────┘
```

H1 ∥ H3 may run in parallel (H1 adds no migration). Every milestone that adds a migration (H2b,
H3, H4, H6) runs **serially**: each starts from, or is rebased onto, the previous one's merge
before it generates its migration, so drizzle's journal and numbering never conflict. After every
merge, `make mac-update` on the Mac (CLAUDE.md › *Working on the live Mac mini*). H2 has no
dependency besides the docs and can go anywhere in the serial chain before H7, which waits for
H2b; its estimate step (H2a) can run at once. Merging follows CLAUDE.md › *Merge when green*. Steps that need Will (H2's choice,
H5's host change, H7's full run) are gathered by the orchestrator as inputs, as in its step 2.

## Status

| Milestone | Status | PR |
|---|---|---|
| M0 Share-link spike | merged | [#3](https://github.com/willchan/bamboo/pull/3) |
| M1 Skeleton, auth, deploy | merged | [#2](https://github.com/willchan/bamboo/pull/2) |
| M2 Phrases, rounds & review | merged | [#5](https://github.com/willchan/bamboo/pull/5) |
| M3 Capture: engine | merged | [#6](https://github.com/willchan/bamboo/pull/6) |
| M4 Worker | merged | [#9](https://github.com/willchan/bamboo/pull/9) |
| M5 Discord intake | merged | [#8](https://github.com/willchan/bamboo/pull/8) |
| M6 Reminder & stats | merged | [#13](https://github.com/willchan/bamboo/pull/13) |
| H1 Pinyin: large dictionary | merged | [#42](https://github.com/willchan/bamboo/pull/42) |
| H2 Frames retired; new-card policy | merged | [#45](https://github.com/willchan/bamboo/pull/45) |
| H3 Card back: breakdowns and glosses | merged | [#43](https://github.com/willchan/bamboo/pull/43) |
| H4 Worker on Gemini | merged | [#44](https://github.com/willchan/bamboo/pull/44) |
| H5 Tutor capture | merged | [#47](https://github.com/willchan/bamboo/pull/47) |
| H6 Re-run extension | merged | [#49](https://github.com/willchan/bamboo/pull/49) |
| H7 Backfill | merged | [#50](https://github.com/willchan/bamboo/pull/50), [#51](https://github.com/willchan/bamboo/pull/51), [#52](https://github.com/willchan/bamboo/pull/52); two keys in [#48](https://github.com/willchan/bamboo/pull/48) |
| T1 Neural TTS spike | proposed (awaiting Will) | |
| T2 Neural TTS | proposed (after T1) | |

Finished milestones (M0–M6, H1–H7) and their **Notes** are in [PLAN-done.md](PLAN-done.md). Read
one there only when your task depends on it; never read that file in full. New milestones go in
this file and move there once merged.

## T1 — Neural TTS spike

*Proposed; starts when Will says go (DESIGN §6.1, §10 #111). Depends on nothing.*

**Will first:** create an Azure AI Speech resource (free tier F0, a region near the Bay Area)
and give the session `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in its own env. Never commit
them.

**Build:** `web/scripts/tts-spike.ts`, which isn't shipped. It synthesizes a fixed list of
**synthetic** phrases: 长了, 长大, 头发很长, 银行, 还钱, 我得走了, 你好, 一个, 不对, 觉得, 睡觉, plus
one example sentence. Each is made in three variants: plain text, polyphones pinned and every
syllable pinned. It uses two or three `zh-CN` neural voices (HD voices included, if they accept
phonemes), with slow replay made both ways (§6.1). It writes the MP3s and an `index.html` to
the gitignored `private/tts-spike/` for Will to play on his iPhone, from the installed PWA's
origin if possible.

**Decide, and record in Notes:** the voice; whether to pin only polyphones or every syllable
(listen for 3-3 sandhi in 你好 and 一/不); the slow-replay method; whether a clip autoplays after
the Start-tap unlock in standalone mode; how F0 counts characters (markup or not) and its rate
limit; and Azure's handling of synthesis input. If Azure fails on readings, repeat with Google
Cloud TTS (`pinyin` alphabet) before giving up.

**Acceptance:** Will's choices are in Notes, and DESIGN §6.1 and §10 #111 are updated to match
(drop "Proposed" from #111 if he goes ahead). No product code.

## T2 — Neural TTS

*Proposed; after T1 (DESIGN §6.1). Adds a migration, so it follows the serial-migration rule.*

**Build:** `web/lib/domain/tts.ts` (`speechSsml`, clip key; tested, including 长了 → `zhang 3`
and an override); migration `tts_clip`; the Azure client (`web/lib/tts-azure.ts`, a timeout,
no retries in the request path); `GET /api/tts/{phraseId}/{part}`; round payload clip URLs and
`after()` warming; `audio.ts` playback with the Web Speech fallback and the unlock; daily-cron
pruning; `config.audio.neural.*`; the `tts_synth` event and `tts_fallback` client log; env in §8.1
and `.env.example`. PRD: audio now matches the card's reading.

**Regression test first:** a card whose displayed pinyin is `zhǎng le` yields SSML that pins
`zhang 3`. It fails before the change because nothing builds SSML.

**Acceptance:** `pnpm lint && pnpm typecheck && pnpm test`, `pnpm --filter web build`, e2e with
the Azure client stubbed (clip served; fallback when it fails); `pnpm --filter web shot
/review/back` unchanged. Manual, Will on his iPhone: the 长了 card says zhǎng; Slow works; Listen
autoplays; airplane mode falls back to the device voice.
