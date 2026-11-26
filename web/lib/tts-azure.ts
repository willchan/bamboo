// Azure AI Speech, real-time synthesis (DESIGN §6.1). One request, a timeout and no retries: the
// request path falls back to Web Speech on any failure, and warming (lib/repo/tts.ts) does its own
// pacing. The key is only ever a header: never logged, never in an error.
import { config } from "./config";

type Env = Readonly<Record<string, string | undefined>>;

export interface AzureSpeech {
  key: string;
  endpoint: string;
}

/**
 * The configured service, or null when neural TTS is off (no key or region). `AZURE_SPEECH_ENDPOINT`
 * replaces the region's endpoint, for the e2e stub only.
 */
export function azureSpeech(env: Env = process.env): AzureSpeech | null {
  const key = env.AZURE_SPEECH_KEY?.trim();
  const region = env.AZURE_SPEECH_REGION?.trim();
  if (!key || !region) return null;
  if (!/^[a-z0-9-]+$/u.test(region)) return null;
  const endpoint =
    env.AZURE_SPEECH_ENDPOINT?.trim() ||
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  return { key, endpoint };
}

export type SynthResult =
  { ok: true; audio: Buffer; ms: number } | { ok: false; status: number; ms: number };

/** Synthesize one SSML document. `status` 0 means no answer (timeout or network). */
export async function synthesize(
  service: AzureSpeech,
  ssml: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SynthResult> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(service.endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": service.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": config.audio.neural.outputFormat,
        "User-Agent": "bamboo",
      },
      body: ssml,
      signal: AbortSignal.timeout(config.audio.neural.requestTimeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, ms: Date.now() - t0 };
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) return { ok: false, status: 502, ms: Date.now() - t0 };
    return { ok: true, audio, ms: Date.now() - t0 };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - t0 };
  }
}
