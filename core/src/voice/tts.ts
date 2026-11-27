import { loadSecret } from "../security/secrets.ts";
import { KokoroSpeech, kokoroCacheDir } from "./kokoro.ts";

/** Turns one sentence of Phoenix's reply into audio. */
export interface SpeechSynth {
  /** "local" runs on this Mac; "cloud" sends reply text to a provider. */
  readonly kind: "local" | "cloud";
  readonly label: string;
  synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string }>;
}

/** "Jessica: Playful, Bright, Warm" from the ElevenLabs voice library. */
export const DEFAULT_VOICE_ID = "r1KmysJdVYZjJCm4mL3b";
/** Lowest-latency ElevenLabs model, suited to a voice assistant. */
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

/**
 * ElevenLabs text-to-speech. Only Phoenix's reply text is sent (never your microphone
 * audio, which is recognised on the Mac), and the API key never leaves the core.
 */
export class ElevenLabsSpeech implements SpeechSynth {
  readonly kind = "cloud";
  readonly label: string;
  #apiKey: string;
  #voiceId: string;
  #model: string;

  constructor(opts: { apiKey: string; voiceId?: string; model?: string }) {
    this.#apiKey = opts.apiKey;
    this.#voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
    this.#model = opts.model ?? DEFAULT_TTS_MODEL;
    this.label = `ElevenLabs (${this.#voiceId})`;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string }> {
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.#voiceId)}` +
      `?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.#apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.#model }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs ${res.status}: ${await describe(res)}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}

async function describe(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string } | string };
    if (typeof body.detail === "string") return body.detail;
    return body.detail?.message ?? body.detail?.status ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export { loadSecret } from "../security/secrets.ts";

/**
 * Which voice Phoenix speaks with:
 *  - default: Kokoro on this Mac (free, private; PHOENIX_VOICE picks the voice, e.g. af_bella)
 *  - PHOENIX_TTS=elevenlabs: ElevenLabs "Jessica" (needs a key; reply text goes to ElevenLabs)
 *  - PHOENIX_TTS=apple: no voice from the core; the Mac app uses Apple's built-in voice
 */
export function speechFromEnvironment(env: NodeJS.ProcessEnv, phoenixHome: string): SpeechSynth | null {
  const mode = env.PHOENIX_TTS ?? "local";
  if (mode === "apple") return null;
  if (mode === "elevenlabs") {
    const apiKey = loadSecret("ELEVENLABS_API_KEY", "elevenlabs-api-key", env);
    if (!apiKey) return null;
    return new ElevenLabsSpeech({
      apiKey,
      voiceId: env.PHOENIX_VOICE_ID || DEFAULT_VOICE_ID,
      model: env.PHOENIX_TTS_MODEL || DEFAULT_TTS_MODEL,
    });
  }
  return new KokoroSpeech({ cacheDir: kokoroCacheDir(phoenixHome), voice: env.PHOENIX_VOICE || undefined });
}
