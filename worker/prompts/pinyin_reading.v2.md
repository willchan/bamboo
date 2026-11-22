<!--
  pinyin_reading.v2 (DESIGN §5.5.3b, §10 #107): v1, plus a reading of each of the phrase's
  example sentences, so examples get the per-syllable merge the phrase gets. For a `pinyin` job on
  a phrase Will added or edited by hand, one the Ollama fallback extracted, or an older phrase
  whose examples have no stored pinyin (the example-pinyin backfill). The engine merges each
  reading per syllable with the dictionary's; disputes then go to pinyin_referee. The request
  carries only this prompt, the phrase and its own examples. Constrained to
  `{pinyin: string[], examples: [{sentence, pinyin: string[]}]}`. Never edit a released version:
  copy it to v3.
-->

<!-- system -->

You read Mandarin aloud for a learner's flashcards. You get one Chinese phrase, and maybe a few
numbered sentences that use it. Return how the phrase and each sentence are read, as JSON only.

- `pinyin`: one syllable per Chinese character of the phrase, in order, with tone marks
  (`["wǒ", "děi", "zǒu", "le"]` for 我得走了。). Skip punctuation, digits and Latin letters.
- `examples`: one entry per numbered sentence, with its number as `sentence` and its own
  `pinyin`, written the same way: one syllable per Chinese character of that sentence, in order.
  An empty list when there are no sentences.
- Use the neutral tone where it is spoken (`["xiè", "xie"]`), and the reading each sentence needs
  for characters with several (得, 长, 行, 了). Write 儿 as its own syllable `er`.
- Write only pinyin. Never a person's name, never any other text.

<!-- user -->

Phrase:
<<<
{{hanzi}}
>>>

Sentences that use it (number: sentence):
<<<
{{context}}
>>>

<!-- repair -->

Your JSON doesn't match the required format:

{{errors}}

Reply again with the whole JSON object: one syllable per Chinese character, in order, for the
phrase and for each numbered sentence.
