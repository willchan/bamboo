# Bamboo — Product Requirements

> Living document. Describes **what** Bamboo does and **why**. Any PR that changes user-visible
> behavior updates this file. Implementation detail lives in [DESIGN.md](DESIGN.md).

## 1. Problem

Will is a second-generation heritage speaker of Mandarin, and his vocabulary has run out. He wants
Mandarin to stay the main language he speaks with his toddler. He speaks it every day with:

- the household's **yuesao** (月嫂, a live-in postpartum carer, who speaks only Chinese),
- his **toddler**, who attends a Mandarin-immersion preschool,
- the toddler's **nanny**.

Today the learning happens in one long **Gemini app** conversation on his phone:

- **"What is she saying?"** He types a toneless guess at a word the yuesao said ("gaoyaguo",
  "podafen", "some sort of shui") and Gemini decodes it (高压锅, 泡打粉, …).
- **"How do I say X?"** Gemini gives a sentence, pinyin, and a key-terms list.
- **Errands and background knowledge**, such as which cut of beef to buy or which rice brand. These are not
  language items.

He uses an answer once or twice and then **forgets it**. The evidence is in his own history:
"*Tell me again* how to say breast milk vs formula" (first asked on day one), and weights or units
asked about four times in ten days.

Why the forgetting happens:

1. **He reads, he doesn't retrieve.** He reads the answer off the screen (or shows the screen), so
   nothing is recalled from memory and nothing sticks.
2. **The items are too big.** Gemini's sentences are long and formal. The parts he can reuse are
   **frames** (阿姨，您是说…吗？ / X 的时候用 Y / …可以吗？) and **nouns**.
3. **There is too much, unsorted.** In ten days, about 70 questions produced around 300 candidate items, most of them one-offs.
4. **Capture is painful.** Saving anything means a pile of screenshots.

Gemini is also sometimes wrong. Its pinyin can be inconsistent within one reply, and the occasional
sentence is unnatural. So nothing it says should be trusted blindly.

## 2. User

A single user (Will), signing in with Google, mostly on an iPhone and occasionally on a laptop.
He is busy, with newborn twins and a toddler, and gives this about **5 minutes a day**. He knows
some hanzi but leans on pinyin for new words; characters still help. He already talks to his
household's **OpenClaw** agent in Discord (PandaBase).

## 3. Learning principles (what the product is built on)

1. **Retrieval, not re-reading.** Every card makes him produce or recall something before showing
   the answer.
2. **Practise the way it will be used.** Most cards are **English intent → say it aloud**. Words
   the yuesao uses get **listen → understand** cards. Reading hanzi is a bonus, not the goal.
3. **Spacing.** Cards are scheduled with FSRS, aiming for about 85% recall to keep the daily load small.
4. **Choosing beats capturing.** He keeps at most ~3 new items a day, picked from a ranked shortlist.
   Everything else expires quietly.
5. **Real use is the real review.** Saying a phrase to the yuesao or his toddler from memory (and
   being understood) is recorded as a review, and is the goal of the whole system.
6. **Small and finished.** A session is about 5 minutes and then says "done". There are no streak guilt mechanics.
7. **Trust nothing the LLM says about pronunciation.** Pinyin is computed from characters (with
   manual override); audio comes from a TTS voice, not from LLM text.

## 4. Product principles (inherited from PandaBase)

1. **Nothing blocks on a human.** Inbox candidates expire; skipped days don't pile up guilt.
2. **Local models only** for every runtime LLM call (Ollama on the Mac mini). Family content
   (children's names, health details) never goes to a cloud LLM API.
3. **Observable.** Extraction quality and review stats are visible so a Claude session can tune
   prompts and ranking later.

## 5. MVP scope (Mandarin only)

### 5.1 Phrases and cards

- A **phrase** is one thing worth remembering:
  - a **term**: a word or short compound (泡打粉), possibly with what he *heard* ("podafen");
  - a **frame**: a reusable pattern with a slot (阿姨，您是说…吗？);
  - a **sentence**: a full thing to say, with who it's for (yuesao, toddler, nanny).
- Each phrase carries: hanzi, English meaning or intent, addressee or context, computed pinyin
  (tone marks), an optional note, and tags (domain: feeding, baby care, food, groceries,
  household, toddler, units, …).
- Each phrase has one or two **cards**:
  - **Say**: the front shows the English intent and who it's for; he says it aloud; the back shows
    hanzi with pinyin above it and plays audio.
  - **Listen**: the front plays audio (and shows "you heard: *podafen*" as a hint if available); he
    recalls the meaning; the back shows everything.
  - Defaults: decoded terms get **Listen** (plus **Say** if he toggles it); frames and sentences get **Say**.
- He can add or edit a phrase by hand. Pinyin recomputes on save, and he can override any
  syllable (polyphones like 得/行/长).

### 5.2 Daily review (the core loop)

- A PWA installed on the iPhone home screen. Opening it shows **Today**: due count, new count, and
  a Start button.
- A session holds at most **3 new cards** and stops after **~20 reviews or 5 minutes**, whichever
  comes first. Then it says it's done and offers "a few more" without pressing.
- Grades: Again / Hard / Good / Easy (FSRS). Big buttons, one hand.
- Audio comes from the device's own Mandarin voice (`zh-CN`). There is a replay button and a slow-replay button.
- **Used it ✓**: on any phrase, from the card back or the phrase list. "I said this for real and
  was understood." It counts as a successful review that day.

### 5.3 Capture: send the conversation to OpenClaw in Discord

- In the Gemini app: Share → export or print the conversation to PDF → share it to Discord, in the
  **`#bamboo`** channel. He can also paste a single Gemini answer there as text.
- OpenClaw's **bamboo** skill picks it up, acknowledges it in one line, and hands it to Bamboo.
  When processing finishes (minutes, on the Mac's local model), it replies in a thread:
  "✅ 9 new questions → 14 candidates. Top: 高压锅 (pressure cooker), … → Inbox".
- He sends the *whole* conversation whenever convenient (daily or every few days). Bamboo processes
  only questions it hasn't seen before. His first send is the backlog and becomes his starter deck.
- Each new turn is classified (**decode / say / errand / other**) and mined for terms, frames and
  sentences. Errand turns contribute at most their nouns.
- Candidates land in the **Inbox** (web), ranked. Items he asked about more than once and words the
  yuesao said rank highest. He sees the top ~10 and taps **Keep**, **Skip**, or **Edit**.
  Unreviewed candidates expire after 14 days. If he asks about something again later, the
  candidate comes back with a higher rank.
- If a candidate matches a phrase he already has, it doesn't create a duplicate; it just records
  that he asked about it again (a signal that he has forgotten it).
- The PWA also has a paste box for a single answer, for when Discord isn't handy.

### 5.4 Daily nudge

- Once a day, at a set time, the bamboo skill posts in `#bamboo` if anything is due or waiting:
  "📚 5 cards · ~3 min · 4 new in Inbox → link". It posts nothing on days with nothing to do,
  and it never follows up.

## 6. Success measures

Reviewed monthly from the Stats page:

- **Habit**: sessions on ≥ 5 days/week.
- **Retention**: FSRS true-retention on reviews ≥ 80%.
- **Real use**: ≥ 3 "Used it ✓" taps per week.
- **Forgetting signal falls**: fewer "asked again" hits for phrases that are already in the deck.
- **Inbox health**: keep rate of the shown shortlist ≥ 30% (lower means ranking or extraction is
  off); extraction errors (bad hanzi, hallucinated items) < 5% of kept items.

## 7. Non-goals (MVP)

- **Cantonese** (deferred; see ROADMAP).
- A chat tutor (Bamboo does not replace Gemini in the moment). Quiz mode in Discord is also deferred.
- Grammar lessons, courses, gamification, streak penalties.
- Handwriting or character-writing practice.
- Pronunciation scoring or speech recognition.
- Multiple users.
- Any cloud LLM call at runtime.
