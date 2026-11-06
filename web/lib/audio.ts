// Device TTS via the Web Speech API (DESIGN §6 *Audio*). Browser-only at call time; the pure
// helpers (voice choice, text prep) are tested in Node.
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

/** Speak hanzi in Mandarin; `slow` uses the slow-replay rate. Cancels anything already speaking. */
export async function speak(hanzi: string, opts: { slow?: boolean } = {}): Promise<void> {
  const s = synth();
  if (!s) return;
  if (chosen === undefined) chosen = pickVoice(await loadVoices());
  const u = new SpeechSynthesisUtterance(speechText(hanzi));
  u.lang = config.audio.lang;
  if (chosen) u.voice = chosen;
  u.rate = opts.slow ? config.audio.slowRate : config.audio.rate;
  s.cancel();
  s.speak(u);
}

/**
 * iOS only lets a page speak after a user gesture. Call this from the Start tap: an empty
 * utterance spoken inside the gesture unlocks speech for the rest of the session.
 */
export function unlockAudio(): void {
  const s = synth();
  if (!s) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  s.speak(u);
}

/** True if the device has a Chinese voice (for the one-time "add a voice" hint). */
export async function hasChineseVoice(): Promise<boolean> {
  if (!synth()) return false;
  return pickVoice(await loadVoices()) !== null;
}
