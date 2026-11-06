#!/usr/bin/env node
// Checks that both readers parse the synthetic fixtures to share-page.expected.json:
// the RPC fixture exactly; the DOM fixture on title, prompts, and the hanzi in each reply.
// M5's share.ts tests should assert the same against the same files.
//
//   node spikes/share-link/check-fixtures.mjs        (needs `npm run setup` for the DOM half)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDom, launchChromium, parseBatchexecute } from './read.mjs';

const F = resolve(dirname(fileURLToPath(import.meta.url)), '../../agent/tools/tests/fixtures');
const expected = JSON.parse(readFileSync(`${F}/share-page.expected.json`, 'utf8'));
const han = (s) => s.replace(/[^\p{Script=Han}]/gu, '');

const rpc = parseBatchexecute(readFileSync(`${F}/share-rpc.txt`, 'utf8'));
assert.deepEqual(rpc.unknownComponents, {});
assert.deepEqual({ title: rpc.title, turns: rpc.turns.map(({ user, reply }) => ({ user, reply })) }, { title: expected.title, turns: expected.turns });
console.log(`rpc fixture: ok (${rpc.turns.length} turns)`);

// The WIZ_global_data values the RPC request needs are findable the same way as on the live page.
const html = readFileSync(`${F}/share-page.html`, 'utf8');
assert.ok(/"cfb2h":"([^"]+)"/.test(html) && /"FdrFJe":"([^"]+)"/.test(html));

const browser = await launchChromium();
try {
  const page = await browser.newPage();
  await page.setContent(html);
  const dom = await extractDom(page);
  assert.equal(dom.title, expected.title);
  assert.equal(dom.turns.length, expected.turns.length);
  dom.turns.forEach((t, i) => {
    assert.equal(t.user, expected.turns[i].user, `turn ${i} prompt`);
    assert.equal(han(t.reply), han(expected.turns[i].reply), `turn ${i} reply hanzi`);
  });
  console.log(`dom fixture: ok (${dom.turns.length} turns)`);
} finally {
  await browser.close();
}
