// Audio (DESIGN §6 *Audio*, §6.1): the card's neural clip on one reused <audio> element, with the
// Web Speech API as the fallback (and the only voice while neural TTS is off). Browser-only at
// call time; the pure helpers (voice choice, text prep) are tested in Node.
import { reportFailure } from "./client/client-log";
import { config } from "./config";

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

const norm = (lang: string) => lang.replace("_", "-").toLowerCase();

/**
 * The best Mandarin voice: `zh-CN` first (then other `zh` voices except Cantonese `zh-HK`), and
 * among those an "Enhanced"/"Premium" voice or Tingting. Null if there's no Chinese voice at all.
 */
export function pickVoice<V extends VoiceLike>(
  voices: readonly V[],
  hints: readonly string[] = config.audio.preferredVoiceHints,
): V | null {
  const score = (v: V) => {
    const lang = norm(v.lang);
    let s = 0;
    if (lang === norm(config.audio.lang)) s += 100;
    else if (lang.startsWith("zh") && lang !== "zh-hk" && !lang.startsWith("yue")) s += 50;
    else return -1;
    const hint = hints.findIndex((h) => v.name.toLowerCase().includes(h.toLowerCase()));
    if (hint >= 0) s += 20 - hint;
    if (v.localService) s += 1;
    return s;
  };
  let best: V | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

/** What to speak: the frame slot `…` (or `...`, `⋯`) becomes a short pause. */
export function speechText(hanzi: string): string {
  return hanzi
    .replace(/(?:…|⋯|\.\.\.)+/gu, "，")
    .replace(/\s+/gu, " ")
    .trim();
}

const synth = (): SpeechSynthesis | null =>
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

/** Voices load asynchronously in some browsers; resolve once they're available (or after 1 s). */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(s.getVoices());
    s.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1000);
  });
}

let chosen: SpeechSynthesisVoice | null | undefined;

/** The utterance rate: normal, or slow replay (DESIGN §6 *Audio*: iOS compresses the range). */
export function speechRate(opts: { slow?: boolean } = {}): number {
  return opts.slow ? config.audio.slowRate : config.audio.rate;
}

/**
 * Speak hanzi in Mandarin; `slow` uses the slow-replay rate. Stops anything already speaking.
 * Each call builds a fresh utterance with voice, lang and rate all set before `speak()` (WebKit
 * reads them when the utterance is queued), and only cancels when something is actually speaking
 * or queued: on iOS a `cancel()` right before `speak()` can swallow the new utterance.
 */
export async function speak(hanzi: string, opts: { slow?: boolean } = {}): Promise<void> {
  const s = synth();
  if (!s) return;
  if (chosen === undefined) chosen = pickVoice(await loadVoices());
  const u = new SpeechSynthesisUtterance(speechText(hanzi));
  if (chosen) u.voice = chosen;
  u.lang = config.audio.lang;
  u.rate = speechRate(opts);
  if (s.speaking || s.pending) s.cancel();
  s.speak(u);
}

// --- Neural clips (DESIGN §6.1) -------------------------------------------------------------

/**
 * Silent MP3 for the unlock: MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz, mono) of zeros, which
 * decode as silence.
 */
export function silentMp3(frames = 4): Uint8Array {
  const FRAME = 417; // 144 * 128000 / 44100, no padding
  const out = new Uint8Array(FRAME * frames);
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0xc0], f * FRAME);
  return out;
}

let silentUrl: string | null = null;
function silentSrc(): string {
  if (!silentUrl) {
    let bin = "";
    for (const b of silentMp3()) bin += String.fromCharCode(b);
    silentUrl = `data:audio/mpeg;base64,${btoa(bin)}`;
  }
  return silentUrl;
}

let element: HTMLAudioElement | null = null;
const player = (): HTMLAudioElement | null => {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  if (!element) {
    element = new Audio();
    element.preload = "auto";
  }
  return element;
};

/** After a failure, go straight to Web Speech until this time (airplane mode: no wait per card). */
let neuralDownUntil = 0;
/** The latest play: an older one that starts late is stopped. */
let playSeq = 0;

/** Test hook: forget the element and any cooldown. */
export function resetAudioForTest(): void {
  element = null;
  neuralDownUntil = 0;
  playSeq = 0;
  chosen = undefined;
}

function stopSpeech() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}

/**
 * Play a clip; resolves true once it's playing, false on an error or no audio within
 * `config.audio.neural.timeoutMs`.
 */
async function playClip(url: string, slow: boolean): Promise<boolean> {
  const el = player();
  if (!el) return false;
  const seq = ++playSeq;
  const rate = slow ? config.audio.neural.slowRate : 1;
  try {
    el.pause();
    const target = new URL(url, location.href).href;
    if (el.src !== target) el.src = target;
    else el.currentTime = 0;
    // A new src resets playbackRate to the default, so set both after it.
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
    el.preservesPitch = true;
    stopSpeech();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([
      el.play().then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), config.audio.neural.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!ok && seq === playSeq) el.pause();
    return ok;
  } catch {
    return false;
  }
}

export interface SayOptions {
  slow?: boolean;
  /** The card part's neural clip (`ReviewCardView.audioUrl`); null or absent → Web Speech. */
  clip?: string | null;
}

/**
 * Say a card part: its neural clip when it has one, else (or if the clip fails) Web Speech, with
 * no UI change. A failure is reported as a `tts_fallback` client log.
 */
export async function say(hanzi: string, opts: SayOptions = {}): Promise<void> {
  const slow = opts.slow ?? false;
  if (opts.clip && Date.now() >= neuralDownUntil) {
    const seq = playSeq + 1;
    if (await playClip(opts.clip, slow)) return;
    // A newer play has taken over: don't talk over it.
    if (seq !== playSeq) return;
    neuralDownUntil = Date.now() + config.audio.neural.failCooldownMs;
    reportFailure({
      where: "tts_fallback",
      err: null,
      kind: navigator.onLine ? "server" : "offline",
    });
  } else {
    playSeq++;
    element?.pause();
  }
  await speak(hanzi, { slow });
}

/**
 * iOS only lets a page speak or play after a user gesture. Call this from the Start tap: an empty
 * utterance spoken and a silent clip played inside the gesture unlock speech and the shared
 * <audio> element for the rest of the session (the round opens by client-side navigation), so a
 * Listen card can autoplay. The silent clip's play may be cut off by the first real clip: that
 * AbortError is expected and ignored (T1).
 */
export function unlockAudio(): void {
  const s = synth();
  if (s) {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    s.speak(u);
  }
  const el = player();
  if (el) {
    try {
      el.src = silentSrc();
      void el.play().catch(() => {});
    } catch {
      // Nothing to unlock.
    }
  }
}

/** True if the device has a Chinese voice (for the one-time "add a voice" hint). */
export async function hasChineseVoice(): Promise<boolean> {
  if (!synth()) return false;
  return pickVoice(await loadVoices()) !== null;
}
