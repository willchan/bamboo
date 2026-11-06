#!/usr/bin/env node
// Writes the synthetic RPC fixture (agent/tools/tests/fixtures/share-rpc.txt) in the exact
// envelope and positional layout observed on a real share link (M0, 2026-11). Every piece of
// text below is invented. share-page.html (the rendered DOM) is hand-written to match it.
//
//   node spikes/share-link/make-fixtures.mjs

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../agent/tools/tests/fixtures/share-rpc.txt');

const TITLE = 'Kitchen and Errands Mandarin';
const SHARE_ID = 'f1x7ure0a1b2';

const TURNS = [
  {
    user: 'How do I ask the nanny to start the rice cooker at five?',
    reply: `Here is a polite, natural way to ask (请 = please).

<Section title="The short version">

Say this:
<TextBox text="请你五点开电饭煲。" subtext="Qǐng nǐ wǔ diǎn kāi diànfànbāo."/>

*   **Key terms:** 五点 (*wǔ diǎn* = five o'clock) | 电饭煲 (*diànfànbāo* = rice cooker)

</Section>

### Quick reference

| English | Chinese | Note |
| :--- | :--- | :--- |
| **Rice cooker** | 电饭煲 | *Common everywhere* |
| **Five o'clock** | 五点 | *Also 五点钟* |

<Image alt="A white rice cooker on a counter" caption="电饭煲 - Example Shop" src="https://example.com/rc.jpg"/>

<ElicitationsGroup message="Want to go further?">
  <Elicitation label="How do I say 'keep warm'?" query="怎么说保温？"/>
  <Elicitation label="Other kitchen appliances" query="Other kitchen appliances in Chinese"/>
</ElicitationsGroup>`,
  },
  {
    user: 'She said something like "gao ya guo".\nWhat is that?',
    reply: `She most likely said **高压锅** (*gāoyāguō*), a pressure cooker.

<Section title="Saying it back">

To check you understood:
<TextBox text="你是说高压锅吗？" subtext="Nǐ shì shuō gāoyāguō ma?"/>

</Section>

<TemplateWidget templateName="checklist" header_title="Before you use it" component_placeholder_id="checklist_0001">
\`\`\`json
{
  "items": [
    { "id": "1", "label": "Check the valve", "checked": false },
    { "id": "2", "label": "Add water first", "checked": false }
  ]
}
\`\`\`
</TemplateWidget>`,
  },
  {
    // A prompt that is only an image: the prompt text is empty.
    user: '',
    reply: `This label says **酱油** (*jiàngyóu*), soy sauce.

*   **生抽** is the light one for cooking.
*   **老抽** is darker and used for colour.`,
  },
  {
    user: 'Thanks! And how do I say "that\'s enough"?',
    reply: `Just say:

够了。

It works for food, water and toys.

<FollowUp label="Want more short replies like this?" query="More short replies in Chinese"/>`,
  },
];

const BASE_TS = 1767225600; // 2026-01-01T00:00:00Z

const hex = (n, i) => (i.toString(16).padStart(n, '0') + 'a1b2c3d4e5f6a7b8c9').slice(0, n);

const turns = TURNS.map((t, i) => [
  [`c_${hex(16, i)}`, `r_${hex(16, i)}`],
  null,
  [[t.user, null, null, null, [[]]], 2, null, 1, hex(16, i + 100), null, null, null, false],
  [
    [[`rc_${hex(16, i)}`, [t.reply], null, null, null, null, null, null, [1], 'en', null, null, []]],
    null,
    null,
    `rc_${hex(16, i)}`,
    null,
    null,
    null,
    null,
    null,
    true,
  ],
  [BASE_TS + i * 600, 123000000],
]);

const payload = [
  [null, turns, [true, TITLE, null, null, null, null, null, [2, hex(16, 999), 'Flash', 19], true], SHARE_ID, [BASE_TS + 3600, 0]],
  null,
  false,
];

const frame = JSON.stringify([['wrb.fr', 'ujx1Bf', JSON.stringify(payload), null, null, null, 'generic']]);
const tail1 = JSON.stringify([['di', 42], ['af.httprm', 41, '-1234567890123456789', 7]]);
const tail2 = JSON.stringify([['e', 4, null, null, frame.length + tail1.length + 40]]);
// The <len> lines count UTF-16 code units of the following chunk (+1 for its newline); parsers
// should not rely on them, so approximate values are fine here.
const body = `)]}'\n\n${frame.length + 1}\n${frame}\n${tail1.length + 1}\n${tail1}\n${tail2.length + 1}\n${tail2}\n`;
writeFileSync(OUT, body);
console.log(`wrote ${OUT} (${body.length} chars, ${TURNS.length} turns)`);
