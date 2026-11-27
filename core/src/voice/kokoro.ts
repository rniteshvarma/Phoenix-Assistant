import path from "node:path";
import type { SpeechSynth } from "./tts.ts";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Warm, natural American female voice (Kokoro's best-rated English voice). */
export const DEFAULT_KOKORO_VOICE = "af_heart";

type KokoroModel = {
  generate(
    text: string,
    opts: { voice: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

/**
 * 16-bit PCM WAV (half the size of the float WAV Kokoro produces), so each sentence's
 * audio stays well under WebSocket message limits.
 */
export function toWav16(samples: Float32Array, sampleRate: number): Buffer {
  const header = 44;
  const buf = Buffer.alloc(header + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), header + i * 2);
  }
  return buf;
}

/**
 * Phoenix's default voice: Kokoro-82M (Apache-2.0) running locally on this Mac via ONNX.
 * Free, no credits, and the reply text never leaves the device. The ~92 MB model is
 * downloaded once into the Phoenix data folder and cached.
 *
 * Sentences are synthesised one at a time, in order, so playback order is preserved
 * and the CPU isn't oversubscribed.
 */
export class KokoroSpeech implements SpeechSynth {
  readonly kind = "local";
  readonly label: string;
  #voice: string;
  #speed: number;
  #cacheDir: string;
  #model: Promise<KokoroModel> | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { cacheDir: string; voice?: string; speed?: number }) {
    this.#cacheDir = opts.cacheDir;
    this.#voice = opts.voice ?? DEFAULT_KOKORO_VOICE;
    this.#speed = opts.speed ?? 1.05;
    this.label = `Kokoro "${this.#voice}" on this Mac`;
  }

  /** Load the model now (first start downloads it), so the first reply isn't delayed. */
  warmUp(): Promise<void> {
    return this.#load().then(() => undefined);
  }

  synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string }> {
    const job = this.#chain.then(async () => {
      if (signal?.aborted) throw new Error("cancelled");
      const model = await this.#load();
      const out = await model.generate(text, { voice: this.#voice, speed: this.#speed });
      return { audio: toWav16(out.audio, out.sampling_rate), mime: "audio/wav" };
    });
    this.#chain = job.catch(() => undefined);
    return job;
  }

  #load(): Promise<KokoroModel> {
    this.#model ??= (async () => {
      const { env } = await import("@huggingface/transformers");
      env.cacheDir = this.#cacheDir;
      const { KokoroTTS } = await import("kokoro-js");
      return (await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" })) as unknown as KokoroModel;
    })();
    this.#model.catch(() => (this.#model = null)); // allow a retry after a failed download
    return this.#model;
  }
}

export function kokoroCacheDir(phoenixHome: string): string {
  return path.join(phoenixHome, "models");
}
