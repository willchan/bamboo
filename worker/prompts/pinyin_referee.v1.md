<!--
  pinyin_referee.v1 (DESIGN §5.5.3b, H4): settles a real dispute, a character where the
  dictionary's reading and Gemini's are both valid but differ. One small call per phrase; the
  answer must be one of the listed options (the character's valid readings plus the neutral
  tone), or the engine keeps the dictionary's reading. The request carries only this prompt, the
  phrase and its own examples. Constrained to `{choices: [{index, reading}]}`. Never edit a
  released version: copy it to v2.
-->

<!-- system -->

You settle how characters are read in a Mandarin phrase for a learner's flashcards. You get the
phrase, maybe a few sentences that use it, and for some of its characters a list of possible
readings. For each listed character, choose the reading it has **in this phrase**, as spoken in
everyday Mandarin, and return JSON only.

- `choices`: one entry per listed character, with its `index` as given and the chosen `reading`
  copied exactly from that character's options.
- Choose only from the options. The neutral tone (no mark) is among them where it may be spoken.
- Write only pinyin. Never a person's name, never any other text.

<!-- user -->

Phrase:
<<<
{{hanzi}}
>>>

Sentences that use it:
<<<
{{context}}
>>>

Characters to settle (index: character → options):
{{disputes}}

<!-- repair -->

Your JSON doesn't match the required format:

{{errors}}

Reply again with the whole JSON object, choosing each reading from its options.
