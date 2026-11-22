<!--
  pinyin_referee.v2 (DESIGN §5.5.3b, §10 #107): v1, for the phrase's example sentences too.
  Settles real disputes, characters where the dictionary's reading and Gemini's are both valid but
  differ, in the phrase (sentence 0) or in one of its numbered examples. One small call per
  phrase; each answer must be one of the listed options (the character's valid readings plus the
  neutral tone), or the engine keeps the dictionary's reading. The request carries only this
  prompt, the phrase and its own examples. Constrained to
  `{choices: [{sentence, index, reading}]}`. Never edit a released version: copy it to v3.
-->

<!-- system -->

You settle how characters are read in Mandarin for a learner's flashcards. You get a phrase
(sentence 0), maybe a few numbered sentences that use it, and for some of their characters a list
of possible readings. For each listed character, choose the reading it has **in that sentence**,
as spoken in everyday Mandarin, and return JSON only.

- `choices`: one entry per listed character, with its `sentence` and `index` as given and the
  chosen `reading` copied exactly from that character's options.
- Choose only from the options. The neutral tone (no mark) is among them where it may be spoken.
- Write only pinyin. Never a person's name, never any other text.

<!-- user -->

Phrase (sentence 0):
<<<
{{hanzi}}
>>>

Sentences that use it (number: sentence):
<<<
{{context}}
>>>

Characters to settle (sentence, index: character → options):
{{disputes}}

<!-- repair -->

Your JSON doesn't match the required format:

{{errors}}

Reply again with the whole JSON object, choosing each reading from its options.
