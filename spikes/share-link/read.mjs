#!/usr/bin/env node
// M0 spike: read a Gemini share link from the Mac. Throwaway; M5 ports the findings to
// agent/tools/src/share.ts. See docs/DESIGN.md §5.2 for what this found.
//
//   node spikes/share-link/read.mjs <link>                # RPC method (default, no browser)
//   node spikes/share-link/read.mjs <link> --dom          # headless Chromium, read the DOM
//   node spikes/share-link/read.mjs <link> --compare      # both; prints agreement counts only
//   node spikes/share-link/read.mjs <link> --save         # also write the parsed result to private/
//
// Prints the title, the turn count and the first 3 user prompts (40 chars). The prompts are Will's
// words: they're for his terminal only. Never paste this output into the repo, a PR or a commit.

import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Google's responses carry more header bytes than Node's default 16 KB limit (fetch() fails with
// UND_ERR_HEADERS_OVERFLOW), so requests go through node:https with a bigger limit.
const MAX_HEADER_SIZE = 256 * 1024;
const MAX_REDIRECTS = 5;
const RPC_ID = 'ujx1Bf'; // "load shared conversation" in Gemini's batchexecute API (observed 2026-11)
const DOM_TIMEOUT_MS = 45_000;

// ---------- small helpers ----------

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = https.request(
      url,
      { method, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers }, maxHeaderSize: MAX_HEADER_SIZE },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${new URL(url).host}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** GET with manual redirects; returns the final response plus the chain of hosts (no paths). */
async function getFollowing(url) {
  const chain = [];
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await request(current);
    chain.push(`${new URL(current).host} ${res.status}`);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { ...res, url: current, chain };
  }
  throw new Error('too many redirects');
}

/** DESIGN §4.1 hanziKey (enough of it to compare methods): CJK ideographs, ASCII letters, digits. */
export function hanziKey(s) {
  return (s ?? '').normalize('NFKC').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLowerCase();
}
const hanOnly = (s) => (s ?? '').replace(/[^\p{Script=Han}]/gu, '');

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

/**
 * The RPC returns each reply as Gemini's own markdown with JSX-like components. Flatten it to
 * plain text: keep the study content (TextBox, Section titles), drop suggestion chips and media.
 * Unknown components are dropped and counted so a format change is visible.
 */
export function flattenRich(md, unknown = new Map()) {
  let s = md;
  // Suggestion chips ("Explore related" in the PDF): whole block goes.
  s = s.replace(/<ElicitationsGroup\b[^>]*>[\s\S]*?<\/ElicitationsGroup>/g, '');
  s = s.replace(/<TextBox\b([^>]*?)\/>/g, (_, a) => {
    const { text = '', subtext = '' } = attrs(a);
    return [text, subtext].filter(Boolean).join('\n');
  });
  // Interactive widgets (seen: templateName="checklist") carry their data as a fenced JSON block.
  // Keep the visible labels as a list; if the JSON isn't the known shape, keep the block as is.
  s = s.replace(/<TemplateWidget\b([^>]*?)>([\s\S]*?)<\/TemplateWidget>/g, (whole, a, body) => {
    const fence = body.match(/```(?:json)?\n([\s\S]*?)```/);
    try {
      const items = JSON.parse(fence?.[1] ?? '').items;
      if (!Array.isArray(items) || !items.every((it) => typeof it?.label === 'string')) throw new Error('shape');
      const head = attrs(a).header_title;
      return [head, ...items.map((it) => `- ${it.label}`)].filter(Boolean).join('\n');
    } catch {
      unknown.set('TemplateWidget(unparsed)', (unknown.get('TemplateWidget(unparsed)') ?? 0) + 1);
      return body;
    }
  });
  s = s.replace(/<Section\b([^>]*?)>/g, (_, a) => attrs(a).title ?? '');
  s = s.replace(/<\/Section>/g, '');
  // Known non-study components go: stray chips, follow-up suggestions, media. Images go with
  // their captions, which are web-page titles from image search, not Gemini's teaching.
  const DROP = new Set(['Elicitation', 'FollowUp', 'Image', 'Video', 'Carousel']);
  s = s.replace(/<\/?([A-Z][\w]*)\b[^<>]*?\/?>/g, (_, name) => {
    if (!DROP.has(name)) unknown.set(name, (unknown.get(name) ?? 0) + 1);
    return '';
  });
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- method 1: RPC over plain HTTPS (no browser) ----------

export async function readViaRpc(link) {
  const t0 = performance.now();
  const page = await getFollowing(link);
  if (page.status !== 200) throw new Error(`share page HTTP ${page.status}`);
  const final = new URL(page.url);
  const shareId = final.pathname.match(/^\/share\/([^/?#]+)/)?.[1];
  if (!shareId) throw new Error('redirect did not land on /share/<id>');
  const bl = page.text.match(/"cfb2h":"([^"]+)"/)?.[1]; // build label
  const sid = page.text.match(/"FdrFJe":"([^"]+)"/)?.[1]; // session id
  const qs = new URLSearchParams({
    rpcids: RPC_ID,
    'source-path': final.pathname,
    hl: 'en-US',
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: 'c',
  });
  if (bl) qs.set('bl', bl);
  if (sid) qs.set('f.sid', sid);
  const fReq = JSON.stringify([[[RPC_ID, JSON.stringify([null, shareId, [4]]), null, 'generic']]]);
  const rpc = await request(`https://${final.host}/_/BardChatUi/data/batchexecute?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1', referer: page.url },
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  if (rpc.status !== 200) throw new Error(`batchexecute HTTP ${rpc.status}`);
  const parsed = parseBatchexecute(rpc.text);
  return { method: 'rpc', ...parsed, ms: Math.round(performance.now() - t0), shareId, chain: page.chain, payloadBytes: rpc.text.length };
}

/**
 * Parse a batchexecute response for the share RPC. Envelope:
 *   )]}'\n\n<len>\n[["wrb.fr","ujx1Bf","<payload JSON as a string>",null,null,null,"generic"]]\n<len>\n[["di",…],["af.httprm",…]]…
 * Payload paths (positional, observed 2026-11): [0][1] turns (oldest first), [0][2][1] title;
 * per turn: [2][0][0] prompt, [3][0][0][1][0] reply (rich markdown), [4] [unix seconds, nanos].
 */
export function parseBatchexecute(text) {
  const line = text.split('\n').find((l) => l.startsWith('[["wrb.fr"'));
  if (!line) throw new Error('batchexecute: no wrb.fr frame');
  const frame = JSON.parse(line)[0];
  if (frame[1] !== RPC_ID || typeof frame[2] !== 'string') throw new Error('batchexecute: empty payload (deleted link?)');
  const data = JSON.parse(frame[2]);
  const convo = data?.[0];
  const rawTurns = convo?.[1];
  if (!Array.isArray(rawTurns)) throw new Error('payload: no turns at [0][1]');
  const unknown = new Map();
  const turns = rawTurns.map((t, i) => {
    const user = t?.[2]?.[0]?.[0];
    const reply = t?.[3]?.[0]?.[0]?.[1]?.[0];
    if (typeof user !== 'string' || typeof reply !== 'string') throw new Error(`payload: turn ${i} has no text at the expected paths`);
    const ts = t?.[4]?.[0];
    return {
      user: user.replace(/\r\n/g, '\n').trim(),
      reply: flattenRich(reply, unknown),
      replyRaw: reply,
      at: typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null,
    };
  });
  const title = convo?.[2]?.[1];
  if (typeof title !== 'string') throw new Error('payload: no title at [0][2][1]');
  return { title, turns, unknownComponents: Object.fromEntries(unknown) };
}

// ---------- method 2: headless Chromium, read the DOM ----------

export async function readViaDom(link) {
  const t0 = performance.now();
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ locale: 'en-US', userAgent: UA });
    const chain = [];
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) chain.push(`${new URL(r.url()).host} ${r.status()}`);
    });
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: DOM_TIMEOUT_MS });
    await page.waitForSelector('share-viewer share-turn-viewer', { timeout: DOM_TIMEOUT_MS });
    // Turns render as one batch after the RPC; wait until the count stops changing.
    let last = -1;
    for (let i = 0; i < 20; i++) {
      const n = await page.locator('share-turn-viewer').count();
      if (n === last) break;
      last = n;
      await page.waitForTimeout(500);
    }
    const result = await extractDom(page);
    return { method: 'dom', ...result, ms: Math.round(performance.now() - t0), chain };
  } finally {
    await browser.close();
  }
}

/** Read the title and turns from a rendered share page (a Playwright Page). */
export function extractDom(page) {
  return page.evaluate(() => {
    // Hide UI chrome inside replies: suggestion chips, image cards (with web-source labels) and
    // table footers carry this class; copy/play buttons are buttons.
    for (const el of document.querySelectorAll('message-content .hide-from-message-actions, message-content button'))
      el.style.display = 'none';
    const text = (el) => (el ? el.innerText.replace(/ /g, ' ').trim() : '');
    const title = text(document.querySelector('share-viewer h1'));
    const turns = [...document.querySelectorAll('share-turn-viewer')].map((tv) => {
      // .query-text also holds a visually hidden "You said" label (h5): read only the lines.
      const user = [...tv.querySelectorAll('user-query .query-text .query-text-line')].map((p) => p.innerText).join('\n');
      const reply = [...tv.querySelectorAll('response-container message-content')].map(text).join('\n\n');
      return { user: user.trim(), reply, at: null };
    });
    return { title, turns };
  });
}

export async function launchChromium() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0'; // the browser lives in this folder's node_modules
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch();
  } catch (e) {
    throw new Error(`can't start Chromium (run \`npm install && npm run setup\` in spikes/share-link): ${e.message}`);
  }
}

// ---------- CLI ----------

const trunc = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function printSummary(r) {
  const empty = r.turns.filter((t) => !t.user).length;
  console.log(`method:  ${r.method} (${r.ms} ms)`);
  console.log(`chain:   ${r.chain.join(' → ')}`);
  if (r.shareId) console.log(`share:   /share/${r.shareId} (compare across re-shares; keep it out of the repo)`);
  console.log(`title:   ${r.title}`);
  console.log(`turns:   ${r.turns.length}${empty ? ` (${empty} with no prompt text, e.g. image-only)` : ''}`);
  const prompts = r.turns.filter((t) => t.user).slice(0, 3);
  prompts.forEach((t, i) => console.log(`  ${i + 1}. ${trunc(t.user, 40)}`));
  const lastAt = r.turns.at(-1)?.at;
  if (lastAt) console.log(`last turn at: ${lastAt}`);
  if (r.unknownComponents && Object.keys(r.unknownComponents).length)
    console.log(`unknown components (dropped): ${JSON.stringify(r.unknownComponents)}`);
}

function compare(a, b) {
  const n = Math.min(a.turns.length, b.turns.length);
  let userKeyEq = 0;
  let userExact = 0;
  let replyHanEq = 0;
  let replyHanIn = 0;
  for (let i = 0; i < n; i++) {
    if (hanziKey(a.turns[i].user) === hanziKey(b.turns[i].user)) userKeyEq++;
    if (a.turns[i].user === b.turns[i].user) userExact++;
    const ha = hanOnly(a.turns[i].reply);
    const hb = hanOnly(b.turns[i].reply);
    if (ha === hb) replyHanEq++;
    else if (ha.includes(hb) || hb.includes(ha)) replyHanIn++;
  }
  console.log('compare (counts only):');
  console.log(`  title equal:               ${a.title.trim() === b.title.trim()}`);
  console.log(`  turns:                     rpc ${a.turns.length}, dom ${b.turns.length}`);
  console.log(`  prompt hanziKey equal:     ${userKeyEq}/${n} (exact text: ${userExact}/${n})`);
  console.log(`  reply hanzi equal:         ${replyHanEq}/${n} (+${replyHanIn} where one contains the other)`);
  console.log(`  timing:                    rpc ${a.ms} ms, dom ${b.ms} ms`);
}

async function main() {
  const args = process.argv.slice(2);
  const link = args.find((a) => !a.startsWith('--'));
  if (!link) {
    console.error('usage: node spikes/share-link/read.mjs <share link> [--dom | --compare] [--save]');
    process.exit(2);
  }
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  let primary;
  if (flags.has('--compare')) {
    const [a, b] = [await readViaRpc(link), await readViaDom(link)];
    printSummary(a);
    compare(a, b);
    primary = a;
  } else {
    primary = flags.has('--dom') ? await readViaDom(link) : await readViaRpc(link);
    printSummary(primary);
  }
  if (flags.has('--save')) {
    const dir = join(REPO, 'private');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `share-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(primary, null, 2));
    console.log(`saved:   ${file} (gitignored; never commit it)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`share_parse_failed: ${e.message}`);
    process.exit(1);
  });
}
