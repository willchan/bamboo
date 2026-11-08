# Bamboo — Product Requirements

> Living document. Describes **what** Bamboo does and **why**. Any PR that changes user-visible
> behavior updates this file. Implementation detail lives in [DESIGN.md](DESIGN.md).

## 1. Problem

Will is a second-generation heritage speaker of Mandarin, and his vocabulary has run out. He wants
Mandarin to stay the main language he speaks with his toddler. He speaks it every day with:

- the household's **yuesao** (月嫂, a live-in postpartum carer, who speaks only Chinese),
- his **toddler**, who attends a Mandarin-immersion preschool,
- the toddler's **nanny**.

Today the learning happens in **Gemini** conversations on his phone, so far mostly one long
conversation. Separate conversations per person (yuesao, toddler, in-laws) are likely later. Three
kinds of question come up:

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
   **frames** (阿姨，您是说…吗？ / X 的时候用 Y / …可以吗？) and **words used in a sentence**.
3. **There is too much, unsorted.** In ten days, about 70 questions produced around 300 candidate items, most of them one-offs.
4. **Capture is painful.** Saving anything means screenshots, or 5–10 taps to print a PDF.

Gemini is also sometimes wrong. Its pinyin can be inconsistent within one reply, and the occasional
sentence is unnatural. So nothing it says should be trusted blindly.

## 2. User

A single user (Will), signing in with Google, mostly on an iPhone and occasionally on a laptop.
He is busy, with newborn twins and a toddler, and will most likely practise **for a few minutes
before bed**, possibly whispering or with earphones. He knows some hanzi but leans on pinyin for new
words; characters still help. He already talks to his household's **OpenClaw** agent in Discord
(PandaBase).

## 3. Learning principles (what the product is built on)

1. **Retrieval, not re-reading.** Every card makes him produce or recall something before showing
   the answer.
2. **Practise the way it will be used.** Most cards are **English intent → say it** (aloud, or
   whispered or mouthed when the house is asleep). Words the yuesao uses get **listen →
   understand** cards. Words always come with an example sentence, so he learns how they are used.
3. **Spacing.** Cards are scheduled with FSRS, aiming for about 85% recall to keep the daily load small.
4. **A tiny daily unit.** The daily goal is **one round** (~10 cards, ~2–3 min), the way
   Duolingo-style apps use a short lesson as the unit. More rounds are optional.
5. **Bamboo chooses; Will corrects.** New material is picked automatically from a ranked queue,
   at most 3 new cards a day. Will never has to sort an inbox; he flags bad picks while reviewing.
6. **Trust nothing the LLM says about pronunciation.** Pinyin is computed from characters (with
   manual override); audio comes from a TTS voice, not from LLM text.

## 4. Product principles (inherited from PandaBase)

1. **Nothing blocks on a human.** No step needs Will to act for the system to keep working.
   Skipped days don't pile up guilt.
2. **Local models only** for every runtime LLM call (Ollama on the Mac mini). Family content
   (children's names, health details) never goes to a cloud LLM API.
3. **Observable.** Extraction and ranking quality are visible so a Claude Code session can tune
   prompts and weights later.

## 5. MVP scope (Mandarin only)

### 5.1 Phrases and cards

- A **phrase** is one thing worth remembering:
  - a **term**: a word or short compound (泡打粉), possibly with what he *heard* ("podafen"),
    with **1–3 example sentences** taken from Gemini's answers;
  - a **frame**: a reusable pattern with a slot (阿姨，您是说…吗？);
  - a **sentence**: a full thing to say, kept short, with who it's for (yuesao, toddler, nanny).
- Each phrase carries: hanzi, English meaning or intent, addressee, computed pinyin (tone marks),
  examples, an optional note, and tags (domain: feeding, baby care, food, groceries, household,
  toddler, units, …).
- Each phrase has one or two **cards**:
  - **Say**: the front shows the English intent and who it's for; he says it; the back shows hanzi
    with pinyin above it, plays audio, and (for terms) shows an example sentence.
  - **Listen**: the front only plays audio; he recalls the meaning; the back shows everything
    including the example, and, if he typed what he heard when he asked, a small "you first heard:
    *podafen*" under the answer, so he sees his guess next to the real thing. (On the front it
    reinforced the mishearing.)
  - Defaults: decoded terms get **Listen**; everything else gets **Say**. A toggle adds the other
    type.
- He can add or edit a phrase by hand. Hand-added phrases go to the front of the queue. Pinyin
  recomputes on save, and he can override any syllable (polyphones like 得/行/长).

### 5.2 Daily review (the core loop)

- A PWA installed on the iPhone home screen. **Today** shows what's due and a **Start** button.
- A **round** is ~10 cards: due cards first, with up to 3 new cards a day mixed in. After a round:
  "✓ Done for today" (one round is the daily goal), plus an optional "Another round (N due)" if
  more is waiting.
- **Learn 3 more**: once today's new cards are used up and new phrases are waiting, Today and the
  end of a round offer a button that starts a round with up to 3 more new cards (plus anything
  due), for today only; he can tap it again later. It's opt-in because each new card adds reviews
  on the days after, and the daily 3 stays the default.
- A card's front is just the prompt; tap it or the **Show** button to see the answer.
- Phrases are added and edited on a **Phrases** page; **Up next** shows the ranked queue with
  Move to top and Remove.
- Grades: Again / Hard / Good / Easy (FSRS). Big buttons, one hand. The next card appears as
  soon as he taps a grade; saving happens in the background, and if it can't save (no signal) the
  screen says so with a Retry button instead of losing the answer.
- A new card he gets right comes back once more later that evening (a ~10-minute learning step),
  then not for weeks. Cards on a learning step come in a different order each round.
- The **first time** a new card appears, two more buttons:
  - **Not useful**: the phrase is dropped, and the drop teaches the ranking.
  - **Already know**: graded Easy, so it comes back much later.
- Audio comes from the device's Mandarin voice (`zh-CN`). There is a replay button and a slow-replay
  button (about a third of normal speed, so it's clearly slower on an iPhone too). Earphones are recommended at night.

### 5.3 Capture: send conversations to OpenClaw in Discord

In order of preference:

1. **Share link** (3 taps): in the Gemini app, Share → Discord → `#bamboo`.
2. **PDF** (fallback, always supported): a printed conversation shared to `#bamboo`.
3. **Pasted answer**: a single Gemini answer pasted into `#bamboo`, or into the PWA's paste box.

The behavior:

- OpenClaw's **bamboo** skill acknowledges in one line and hands the conversation to Bamboo. When
  processing finishes (minutes, on the Mac's local model), it replies:
  "✅ 9 new questions → 14 phrases queued. Next up: 高压锅 gāo yā guō (pressure cooker), …". Any
  Mandarin in a Bamboo reply comes with its pinyin (the same reading the app shows, including his
  corrections), because new words use characters he can't read yet. After a link
  import, the reply also reminds him that the link is public and can be deleted in Gemini
  (Settings → Public links). When nothing in it is new, the acknowledgement itself says
  "✅ Nothing new since last time." (with the same reminder for a link), and no second reply
  follows. If a link can't be read, it asks for the PDF; if a PDF can't be read, for the link.
- Brief network blips between the Mac and Bamboo's server are silent in `#bamboo`. Only if the
  Mac can't reach the server for half an hour does one message say so ("I'll keep trying"),
  followed by one line when it's back. A setup problem (a wrong token, say) is posted once.
- He shares a **whole conversation** whenever convenient, as often as he likes, from any number of
  conversations. Bamboo processes only questions it hasn't seen before. The first share is the
  backlog and becomes his starter material. The conversation's title ("Yuesao…", "Toddler…") is
  used as context for who phrases are for.
- Each new question is classified (**decode / say / errand / other**) and mined for terms (with
  examples), frames and short sentences. Errand questions contribute at most their nouns.
- Everything extracted goes into a ranked **Up next** queue. Ranking:
  - words the yuesao said rank high;
  - anything asked about more than once ranks high;
  - reusable frames rank high;
  - core topics get a boost;
  - the local model's "how likely to come up again at home" rating counts;
  - long sentences sink;
  - old items fade.
- Each day the top items become new cards. **Up next** can be browsed (move to top, remove), but
  never has to be.
- If he asks again about something he's already learning, Bamboo doesn't duplicate it. It treats
  this as **forgotten** and shows it again soon. A dropped item he asks about again returns to
  the queue (or straight back into review, if he had already started learning it).
- The PWA's **Imports** tab lists recent imports with their counts, any questions that couldn't be
  processed (with **Retry failed**), and the paste box. **Today** shows a line when questions are
  waiting and the Mac's worker hasn't been heard from for a while.

### 5.4 Daily reminder

- One message in `#bamboo`, in the evening, if a round is due and not yet done:
  "📚 1 round · ~3 min · 7 due · 2 new → link". The default time is 21:00; once he has practised on
  5 of the last 14 days it moves to 15 minutes before his usual practice time (between 18:00 and
  23:00). There's nothing on days with nothing to do, and never a follow-up. A switch on Today
  turns it off and on and shows today's time.

## 6. Success measures

Reviewed monthly from the Stats page:

- **Habit**: a round on ≥ 5 days/week.
- **Retention**: FSRS true-retention on reviews ≥ 80%.
- **Forgetting signal falls**: fewer "asked again" hits on phrases he's already learning.
- **Ranking quality**: "Not useful" on < 15% of introduced phrases.
- **Extraction quality**: invented or garbled items < 5% of introduced phrases (hanzi not found in
  the source, wrong meaning).

The Stats page (its own tab) shows each of these for the last 4 weeks, next to its target. It
measures extraction quality as the share of the model's items dropped because their hanzi weren't
in the source; a wrong meaning that slips through shows up as "Not useful". It also shows the
queue size and when the Mac worker was last seen.

## 7. Non-goals (MVP)

- **Cantonese** (deferred; see ROADMAP).
- A chat tutor: Gemini stays the tutor. A local-model comparison is in ROADMAP.
- A quiz mode in Discord.
- "Used it for real" tracking.
- Grammar lessons, courses, gamification, streak penalties.
- Handwriting or character-writing practice.
- Pronunciation scoring or speech recognition.
- Multiple users.
- Any cloud LLM call at runtime.
