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

> **2026-11: the Gemini-backed hybrid.** Will decided to move tutoring and extraction to Gemini
> (DESIGN §5.5, §10 #74–#83; built in docs/PLAN.md › *Hybrid H1–H7*). The sections below
> describe the target; where the running app still differs, the text says "until H<N>".

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
5. **Bamboo chooses; Will corrects.** New material is picked automatically, **freshest first**, and
   learned while it's fresh rather than rationed: a burst of new cards, then a steady state (the
   daily limit is 30 new cards, Will's choice from an estimate of the reviews it brings: about
   three weeks of burst, then roughly 115 cards, about half an hour, a day at today's capture
   rate). Will never has to sort an inbox; he flags bad picks while reviewing.
6. **Pronunciation is never taken from the LLM alone.** Pinyin is computed from characters with a
   dictionary; Gemini only chooses among the dictionary's readings for a character, where the
   sentence decides (a polyphone), and Will's override wins. Audio comes from a TTS voice, not
   from LLM text.

## 4. Product principles (inherited from PandaBase)

1. **Nothing blocks on a human.** No step needs Will to act for the system to keep working.
   Skipped days don't pile up guilt.
2. **Gemini, with family details kept out.** Since 2026-11, Gemini is the tutor (the `#bamboo`
   agent) and the extractor, because the tutor evaluation showed the local models were clearly
   worse (DESIGN §10 #58, #74). A local model stays only as a fallback extractor. Only the turn
   and the prompt go to Gemini. Prompts say never to put a person's name in an answer or card
   (宝宝, 孩子, 阿姨, 月嫂 or 妈妈 instead) and to keep personal health specifics (diagnoses,
   doses, measurements) out of cards; a name list kept only on the Mac drops anything that slips
   through. *(Was: local models only.)*
3. **Observable.** Extraction and ranking quality are visible so a Claude Code session can tune
   prompts and weights later.

## 5. MVP scope (Mandarin only)

### 5.1 Phrases and cards

- A **phrase** is one thing worth remembering:
  - a **term**: a word or short compound (泡打粉), possibly with what he *heard* ("podafen"),
    with **1–3 example sentences** (not ones with a word spelled in pinyin, romanization or
    English, like a question about what "podafen" meant), each with its English. Since 2026-11
    Gemini writes them for the card: short, everyday sentences showing how the word is used, one
    for a noun (what it goes with), up to three for a verb or grammar word (each a different
    pattern), never several that reword the same sentence. Before that they were copied from
    the answer, which is about that day's question, so a word's examples were often rewordings
    of Will's own question;
  - ~~a **frame**: a reusable pattern with a slot (阿姨，您是说…吗？)~~ **removed** (2026-11):
    frames are no longer extracted, and existing ones are retired (H2: dropped, their history
    kept);
  - a **sentence**: a full thing to say, kept short. Every "how do I say" question yields one:
    if the model leaves it out, the shortest example sentence for its words that the answer
    itself offered is used.
- Each phrase carries: hanzi, English meaning or intent, computed pinyin (tone marks), examples,
  an optional note, and tags (domain: feeding, baby care, food, groceries, household,
  toddler, units, …). There's no fixed "who it's for" field: who Will is talking to rarely changes
  the Chinese. When it does (baby talk to the toddler, 您 to an adult), the extractor says so in
  the note ("polite, to an adult"), shown on the back of the card.
- Each phrase has one or two **cards**:
  - **Say**: the front shows the English intent; he says it; the back shows hanzi
    with pinyin above it, plays audio, and (for terms) shows an example sentence.
  - **A richer back** (H3, H4): a term's back shows a **character breakdown** (each character with
    its pinyin and a short gloss, then the word's overall meaning) and its example sentence(s); a
    sentence's back shows a **word-by-word gloss** and one short note on how the sentence is
    built. Gemini writes the glosses (from H4; H3 built the card back); the breakdown always
    matches the phrase's characters, and its pinyin is the phrase's own. A card without one
    looks as before. An example's pinyin is checked the way the phrase's is (2026-11): Gemini's
    reading of the sentence, kept only where it's a valid dictionary reading, with disputes
    settled by a second look; the phrase's own characters in it always read as on the card.
  - **Listen**: the front only plays audio; he recalls the meaning; the back shows everything
    including the example, and, if he typed what he heard when he asked, a small "you first heard:
    *podafen*" under the answer, so he sees his guess next to the real thing. (On the front it
    reinforced the mishearing.)
  - Defaults: decoded terms get **Listen**; everything else gets **Say**. A toggle adds the other
    type.
- He can add or edit a phrase by hand. Hand-added phrases go to the front of the queue. Pinyin
  recomputes on save (the dictionary reading at once; from H4 a quick check by Gemini on the Mac
  settles polyphones shortly after), and he can override any syllable (得/行/长).

### 5.2 Daily review (the core loop)

- A PWA installed on the iPhone home screen. **Today** shows what's due and a **Start** button.
- A **round** is ~10 cards: due cards first, with new cards mixed in (up to 30 a day; §3,
  principle 5). After a round:
  "✓ Done for today" (one round is the daily goal), plus an optional "Another round (N due)" if
  more is waiting.
- **Keep going** (while there's a backlog: 30 or more phrases waiting, and today's 30 new cards
  not yet reached): after the first round, the end of a round starts the next one by itself, new
  cards first, until today's 30 are introduced; ✕ stops, and Today offers "Keep going (N new
  left)". Once the backlog is gone it's "Another round" again. Today and the end of a round show
  "N of 30 new today".
- **Learn 3 more**: once today's new cards are used up and new phrases are waiting, Today and the
  end of a round offer a button that starts a round with up to 3 more new cards (plus anything
  due), for today only; he can tap it again later. It's opt-in because each new card adds reviews
  on the days after, and the daily limit stays the default.
- A card's front is just the prompt; tap it or the **Show** button to see the answer.
- Phrases are added and edited on a **Phrases** page; **Up next** shows the ranked queue with
  Move to top and Remove.
- Grades: Again / Hard / Good / Easy (FSRS). Big buttons, one hand. The next card appears as
  soon as he taps a grade; saving happens in the background, and if it can't save (no signal) the
  screen says so with a Retry button instead of losing the answer. Answers not yet saved survive
  a reload. When Bamboo has been updated since the page opened, the app reloads itself into the
  new version (on opening, or when a save fails because of it) and sends those answers then,
  instead of offering a Retry that can't work.
- A new card he gets right is done for the evening and comes back in about two weeks. One he
  misses (Again) or finds hard comes back a minute or two later, in the same round or the next.
  Cards on a learning step come in a different order each round.
- The **first time** a new card appears, two more buttons:
  - **Not useful**: the phrase is dropped, and the drop teaches the ranking.
  - **Already know**: graded Easy, so it comes back much later.
- Audio comes from the device's Mandarin voice (`zh-CN`). There is a replay button and a slow-replay
  button (about a third of normal speed, so it's clearly slower on an iPhone too). Earphones are recommended at night.

### 5.3 Capture: send conversations to OpenClaw in Discord

`#bamboo` is a Discord forum: each question or shared conversation is a **new post**, with a
fresh conversation for the tutor, and a reply inside a post follows up on that one. Bamboo's
replies (the "✅ … queued" summary) land inside the post they answer.

In order of preference:

1. **Ask in `#bamboo`** (H5): the `#bamboo` agent is the tutor, on Gemini Flash. Every question
   Will asks there, and its answer, is captured by Bamboo automatically, with no share link. The agent answers; it never writes cards itself.
   Its answer is the only reply: no "✅ … queued" summary follows a question. It never puts a
   person's name in an answer (it says 宝宝, 孩子, 阿姨, 月嫂 or 妈妈) or personal health
   specifics, because every answer becomes cards. When the free Gemini quota is used up for the
   day, it keeps answering on PandaDen's paid key; the cards from those answers arrive after the
   quota resets.
2. **Share link** (3 taps): in the Gemini app, Share → Discord → `#bamboo`.
3. **PDF** (fallback, always supported): a printed conversation shared to `#bamboo`.
4. **Pasted answer**: a single Gemini answer pasted into `#bamboo`, or into the PWA's paste box.
   In `#bamboo`, a long, multi-line message with Chinese counts as a pasted answer and anything
   shorter as a question for the tutor. Starting a message with `paste:` or `ask:` settles it
   either way.

The behavior:

- OpenClaw's **bamboo** skill acknowledges in one line and hands the conversation to Bamboo. When
  processing finishes (minutes; each question goes to Gemini on its own, at the free tier's
  rate), it replies:
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
  examples) and short sentences (no frames since 2026-11). Since H4 Gemini does this, with
  Bamboo's checks on everything it returns: a "how do I say" question gives its sentence and up to
  5 key words (each with up to 3 example sentences); an errand question up to 3
  nouns, often none. The earlier caps (2 words, 1 noun) were set for the local model; a comparison
  with decks Gemini made showed Bamboo missing real words. Nothing that names a person reaches a
  card.
- Everything extracted goes into a ranked **Up next** queue. Ranking:
  - **common words rank high**: how often a word is used in everyday spoken Mandarin, from a
    bundled word list (not the LLM's opinion). Baby and feeding words aren't held back for being
    rare in that list, since they're daily language at home;
  - anything asked about more than once ranks high;
  - words the yuesao said rank high;
  - the local model's "how often will this come up at home" rating counts;
  - errand items and long sentences sink;
  - old items fade slowly.
- **Freshest first**: new cards are introduced most recently asked first (pinned ones before
  that; the ranking above only breaks ties), so words are learned while the moment they were
  needed is fresh.
- Each day the top items become new cards. **Up next** can be browsed (move to top, remove), but
  never has to be.
- **Nothing unseen expires**: there's no queue budget; everything waits until it's learned.
  Not useful and Already know stay. Phrases that expired before H2 come back if he asks about
  them again, or he can restore them from Phrases.
- If he asks again about something he's already learning, Bamboo doesn't duplicate it. It treats
  this as **forgotten** and shows it again soon. A dropped item he asks about again returns to
  the queue (or straight back into review, if he had already started learning it).
- The PWA's **Imports** tab lists recent imports with their counts, any questions that couldn't be
  processed (with **Retry failed**), and the paste box. When the extraction prompt has improved,
  it offers to **Re-run** the questions read with an older one: the queue then reflects the
  newer reading (expired phrases it still wants come back, fragments it no longer wants leave),
  without counting as asking again. Cards being learned and phrases Will removed are untouched.
  A re-run also refreshes the English, note, breakdown and pinyin of every phrase it picks,
  whatever its status (never the characters, his pinyin corrections or the review history).
  Queued phrases it no longer picks are removed (he can restore them from Phrases); ones he's
  learning, moved to the top or asked about again stay, and Imports links to them under Phrases'
  **unpicked** filter, with a bulk **Retire** that drops them and keeps their history. H7 rebuilds
  the queue this way from all stored questions, without wiping anything. **Today** shows a line when questions are
  waiting and the Mac's worker hasn't been heard from for a while.

### 5.4 Daily reminder

- One new post in `#bamboo`, in the evening, if a round is due and not yet done:
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
queue size and when the Mac worker was last seen, and (from H4) how often Bamboo's and Gemini's
pinyin disagreed and how each disagreement was settled.

## 7. Non-goals (MVP)

- **Cantonese** (deferred; see ROADMAP).
- A chat tutor inside the PWA. The tutor is the `#bamboo` agent on Gemini (§5.3, H5).
- A quiz mode in Discord.
- "Used it for real" tracking.
- Grammar lessons, courses, gamification, streak penalties.
- Handwriting or character-writing practice.
- Pronunciation scoring or speech recognition.
- Multiple users.
- Any cloud LLM other than Gemini, or any LLM call from the State Engine.
