// T1 listening spike (DESIGN §6.1, PLAN › T1). NOT shipped. Synthesizes a synthetic phrase list in
// three variants (plain, polyphones pinned, every syllable pinned) across a few zh-CN neural voices,
// with slow replay made two ways (SSML prosody rate; playbackRate in the page). Writes MP3s and an
// index.html to the gitignored private/tts-spike/.
//   pnpm --filter web exec tsx scripts/tts-spike.ts [--serve]
// Reads AZURE_SPEECH_KEY / AZURE_SPEECH_REGION from web/.env.local. Never prints the key.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computePinyin, pinyinSlots } from "../lib/domain/pinyin";

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../.env.local"));
} catch {
  /* env may already be set */
}
const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION;
const outDir = resolve(import.meta.dirname, "../../private/tts-spike");

const PHRASES = [
  "长了",
  "长大",
  "头发很长",
  "银行",
  "还钱",
  "我得走了",
  "你好",
  "一个",
  "不对",
  "觉得",
  "睡觉",
  "我觉得宝宝今天长高了。",
];
// TTS_VOICES overrides. An HD voice may reject phonemes; a failure is recorded, not fatal.
const VOICES = (process.env.TTS_VOICES ?? "zh-CN-XiaoyiNeural").split(",");
// What the card would display after Gemini's merge / Will's override (the engine's computed default
// is wrong for these). Per-character readings; anything absent uses the computed pinyin.
const SHOWN: Record<string, string[]> = {
  长了: ["zhǎng", "le"],
  我得走了: ["wǒ", "děi", "zǒu", "le"],
  "我觉得宝宝今天长高了。": [
    "wǒ",
    "jué",
    "de",
    "bǎo",
    "bao",
    "jīn",
    "tiān",
    "zhǎng",
    "gāo",
    "le",
    "",
  ],
};
const shown = (hanzi: string) =>
  computePinyin(hanzi).map(([c, py], i): [string, string | null] => [
    c,
    py === null ? null : (SHOWN[hanzi]?.[i] ?? py),
  ]);
const SLOW_RATE = "-30%";
const VARIANTS = ["plain", "poly", "all"] as const;
type Variant = (typeof VARIANTS)[number];

const MARKS: Record<string, [string, number]> = {};
for (const [base, row] of Object.entries({
  a: "āáǎà",
  e: "ēéěè",
  i: "īíǐì",
  o: "ōóǒò",
  u: "ūúǔù",
  v: "ǖǘǚǜ",
}))
  [...row].forEach((c, i) => (MARKS[c] = [base, i + 1]));

/** "zhǎng" → "zhang 3"; neutral → 5; ü → v (Azure zh-CN sapi). */
export function toSapi(py: string): string {
  let tone = 5;
  let out = "";
  for (const c of py.toLowerCase()) {
    const m = MARKS[c];
    if (m) {
      out += m[0];
      tone = m[1];
    } else out += c === "ü" ? "v" : c;
  }
  return `${out} ${tone}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ssml(hanzi: string, variant: Variant, voice: string, rate?: string): string {
  const pairs = shown(hanzi);
  const slots = pinyinSlots(hanzi);
  const body = pairs
    .map(([c, py], i) => {
      if (py === null || variant === "plain") return esc(c);
      if (variant === "poly" && (slots[i]?.readings.length ?? 0) < 2) return esc(c);
      return `<phoneme alphabet="sapi" ph="${toSapi(py)}">${esc(c)}</phoneme>`;
    })
    .join("");
  const inner = rate ? `<prosody rate="${rate}">${body}</prosody>` : body;
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${voice}">${inner}</voice></speak>`;
}

interface Result {
  file?: string;
  chars: number;
  ms: number;
  error?: string;
}
const limits = new Set<string>();

const PACE_MS = 3200; // F0 allows about 20 requests a minute
let last = 0;
let throttled = 0;
async function synth(
  xml: string,
  attempt = 0,
): Promise<{ audio?: Buffer; ms: number; error?: string }> {
  const wait = last + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const t0 = Date.now();
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key!,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "bamboo-tts-spike",
    },
    body: xml,
  });
  for (const [k, v] of res.headers)
    if (/rate|limit|remaining|retry|request-?id/i.test(k) && !/id/i.test(k))
      limits.add(`${k}: ${v}`);
  if (res.status === 429 && attempt < 6) {
    throttled++;
    await new Promise((r) => setTimeout(r, 15000));
    return synth(xml, attempt + 1);
  }
  if (!res.ok)
    return { ms: Date.now() - t0, error: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
  return { audio: Buffer.from(await res.arrayBuffer()), ms: Date.now() - t0 };
}

async function main() {
  if (!key || !region)
    throw new Error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing (web/.env.local)");
  mkdirSync(outDir, { recursive: true });
  const rows: {
    hanzi: string;
    voice: string;
    variant: Variant;
    normal: Result;
    slow: Result;
    pinyin: string;
  }[] = [];
  let totalChars = 0;
  for (const voice of VOICES) {
    for (const hanzi of PHRASES) {
      for (const variant of VARIANTS) {
        const one = async (rate: string | undefined, tag: string): Promise<Result> => {
          const xml = ssml(hanzi, variant, voice, rate);
          const r = await synth(xml);
          if (!r.audio) return { chars: xml.length, ms: r.ms, error: r.error };
          totalChars += xml.length;
          const file = `${voice.replace(/\W+/g, "_")}-${PHRASES.indexOf(hanzi)}-${variant}-${tag}.mp3`;
          writeFileSync(join(outDir, file), r.audio);
          return { file, chars: xml.length, ms: r.ms };
        };
        const normal = await one(undefined, "n");
        const slow =
          variant === "poly" && process.env.TTS_SLOW
            ? await one(SLOW_RATE, "s")
            : { chars: 0, ms: 0 };
        const pinyin = shown(hanzi)
          .map(([, p]) => p ?? "")
          .join(" ");
        rows.push({ hanzi, voice, variant, normal, slow, pinyin });
        if (normal.error) console.log(`  ${voice} ${variant} ${hanzi}: ${normal.error}`);
      }
    }
  }
  const ok = rows.filter((r) => r.normal.file).length;
  console.log(`clips ok ${ok}/${rows.length}; request chars incl. markup: ${totalChars}`);
  console.log(`429 retries: ${throttled}`);
  console.log(`rate-limit headers seen: ${[...limits].join(" | ") || "none"}`);
  writeFileSync(join(outDir, "index.html"), page(rows));
  console.log(`wrote ${outDir}/index.html`);
}

function page(rows: Parameters<typeof tableRows>[0]): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TTS spike</title><style>body{font:16px system-ui;margin:12px}h2{margin:18px 0 4px}
table{border-collapse:collapse;width:100%}td{padding:4px;border-bottom:1px solid #8884;font-size:14px}
button{font-size:16px;padding:6px 10px}</style>
<h1>T1 TTS spike</h1>
<p>Variants: <b>plain</b> (no pins), <b>poly</b> (polyphones pinned), <b>all</b> (every syllable). Per row:
▶ normal; ▶ slow-SSML (poly only, rate ${SLOW_RATE}); ▶ x0.7 = playbackRate 0.7 on the normal clip.</p>
<p><button id="unlock">Start (tap, then test autoplay)</button> <button id="auto">Autoplay in 2 s</button> <span id="msg"></span></p>
<audio id="a" playsinline></audio>
${tableRows(rows)}
<script>
const a=document.getElementById('a'),msg=document.getElementById('msg');
function play(f,r){a.src=f;a.playbackRate=r||1;a.preservesPitch=true;a.play().catch(e=>msg.textContent='blocked: '+e.name)}
document.addEventListener('click',e=>{const b=e.target.closest('[data-f]');if(b)play(b.dataset.f,+b.dataset.r)});
document.getElementById('unlock').onclick=()=>{a.src='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';a.play().then(()=>msg.textContent='unlocked').catch(e=>msg.textContent='unlock failed: '+e.name)};
document.getElementById('auto').onclick=()=>{msg.textContent='waiting…';setTimeout(()=>{const b=document.querySelector('[data-f]');play(b.dataset.f,1);setTimeout(()=>{if(a.paused)msg.textContent='autoplay BLOCKED'; else msg.textContent='autoplay worked'},800)},2000)};
</script>`;
}

function tableRows(
  rows: {
    hanzi: string;
    voice: string;
    variant: Variant;
    normal: Result;
    slow: Result;
    pinyin: string;
  }[],
): string {
  let html = "";
  let cur = "";
  for (const r of rows) {
    const head = `${r.voice} — ${r.hanzi} (${r.pinyin})`;
    if (head !== cur) {
      if (cur) html += "</table>";
      html += `<h2>${head}</h2><table>`;
      cur = head;
    }
    const btn = (res: Result, label: string, rate = 1) =>
      res.file
        ? `<button data-f="${res.file}" data-r="${rate}">${label}</button>`
        : res.chars
          ? `<small>${esc(res.error ?? "")}</small>`
          : "";
    html += `<tr><td>${r.variant}</td><td>${btn(r.normal, "▶")}</td><td>${btn(r.slow, "▶ slow")}</td><td>${r.normal.file ? btn(r.normal, "▶ x0.7", 0.7) : ""}</td></tr>`;
  }
  return html + "</table>";
}

if (process.argv.includes("--serve")) {
  const port = 8099;
  createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0]!.replace(/^\/+/, "") || "index.html";
    try {
      const body = readFileSync(join(outDir, name.replace(/\.\./g, "")));
      res.setHeader(
        "Content-Type",
        name.endsWith(".mp3") ? "audio/mpeg" : "text/html; charset=utf-8",
      );
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  }).listen(port, "0.0.0.0", () => console.log(`serving ${outDir} on :${port}`));
} else {
  await main();
}
