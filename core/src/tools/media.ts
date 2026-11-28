import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { allowedRoots, resolveAllowed } from "../privacy/documents.ts";
import { defineTool, type ToolContext } from "./types.ts";

/**
 * Phase 5: images, screen recordings and video edits, all made on this Mac by the Phoenix app:
 * Apple's on-device Image Playground for images, ScreenCaptureKit for recordings, AVFoundation
 * and on-device speech recognition for edits and captions. Results are always new files
 * (never overwriting) in ~/Pictures/Phoenix or ~/Movies/Phoenix; nothing is uploaded anywhere.
 */

const MEDIA_ROOTS = () => [...allowedRoots(), path.join(os.homedir(), "Movies"), path.join(os.homedir(), "Pictures")];
const resolveMedia = (file: string) => resolveAllowed(file, MEDIA_ROOTS());
const VIDEO = /\.(mov|mp4|m4v)$/i;
const AUDIO_OR_VIDEO = /\.(mov|mp4|m4v|m4a|mp3|wav|aac|caf)$/i;

/** Long jobs (video export, transcription) get up to 15 minutes. */
const onMac = (tool: string, timeoutMs = 15 * 60_000) => (input: unknown, ctx: ToolContext) =>
  ctx.devices.call("media", tool, input, timeoutMs);

/** "1:05", "65", "00:01:05.5" → seconds. */
export function parseTime(t: string | number): number {
  if (typeof t === "number") return t;
  const parts = t.trim().split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p) || p < 0)) throw new Error(`can't read the time "${t}"`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const time = z.union([z.number().nonnegative(), z.string().regex(/^\d+(:\d{1,2}){0,2}(\.\d+)?$/)]);

export const imageCreate = defineTool({
  name: "image_create",
  tier: Tier.Prepare,
  description:
    "Create images on this Mac with Apple's on-device Image Playground (nothing is uploaded). Styles: animation (3D, playful), " +
    "illustration (flat, graphic) or sketch. Optionally start from one of the user's photos (e.g. a family photo for a Diwali card). " +
    "Saved to ~/Pictures/Phoenix and opened in Preview. Not for photorealistic images.",
  schema: z.strictObject({
    prompt: z.string().min(3).max(400).describe("What to create, in a few vivid words"),
    style: z.enum(["animation", "illustration", "sketch"]).default("animation"),
    photo: z.string().max(500).optional().describe("Optional path to a photo to base it on"),
    count: z.number().int().min(1).max(4).default(2),
  }),
  describe: (i) => `Create ${i.count} ${i.style} image${i.count === 1 ? "" : "s"}: "${i.prompt}"`,
  run: async (i, ctx) => onMac("image_create", 5 * 60_000)({ ...i, photo: i.photo ? resolveMedia(i.photo) : undefined }, ctx),
});

export const screenRecordStart = defineTool({
  name: "screen_record_start",
  tier: Tier.Prepare,
  description: "Start recording the Mac's screen (stays on this Mac). With audio, the microphone and system sound are recorded too. Stops by itself after 30 minutes.",
  schema: z.strictObject({ audio: z.boolean().default(true) }),
  describe: (i) => `Start recording the screen${i.audio ? " with sound" : ""}`,
  run: onMac("screen_record_start", 30_000),
});

export const screenRecordStop = defineTool({
  name: "screen_record_stop",
  tier: Tier.Prepare,
  description: "Stop the screen recording and save it to ~/Movies/Phoenix. Returns the file path.",
  schema: z.strictObject({}),
  describe: () => "Stop the screen recording",
  run: onMac("screen_record_stop", 60_000),
});

export const videoTrim = defineTool({
  name: "video_trim",
  tier: Tier.Prepare,
  description: "Trim a video to the part between start and end (seconds or m:ss). Saves a new file; the original is untouched.",
  schema: z.strictObject({ file: z.string().min(1).max(500), start: time, end: time })
    .refine((i) => parseTime(i.end) > parseTime(i.start), "'end' must be after 'start'"),
  describe: (i) => `Trim ${path.basename(i.file)} to ${i.start}–${i.end}`,
  async run(i, ctx) {
    const file = resolveMedia(i.file);
    if (!VIDEO.test(file)) throw new Error("that isn't a video file (.mov, .mp4, .m4v)");
    return onMac("video_trim")({ file, start: parseTime(i.start), end: parseTime(i.end) }, ctx);
  },
});

export const videoCaptions = defineTool({
  name: "video_captions",
  tier: Tier.Prepare,
  description:
    "Add captions to a video: speech is transcribed on this Mac, burned into a new copy of the video, and also saved as an .srt file. " +
    "Language defaults to English (India).",
  schema: z.strictObject({ file: z.string().min(1).max(500), language: z.string().max(10).default("en-IN") }),
  describe: (i) => `Add captions to ${path.basename(i.file)}`,
  async run(i, ctx) {
    const file = resolveMedia(i.file);
    if (!VIDEO.test(file)) throw new Error("that isn't a video file (.mov, .mp4, .m4v)");
    return onMac("video_captions")({ file, language: i.language }, ctx);
  },
});

export const videoRemoveSilence = defineTool({
  name: "video_remove_silence",
  tier: Tier.Prepare,
  description: "Cut the silent gaps out of a video (pauses longer than minSilence seconds). Saves a new file.",
  schema: z.strictObject({ file: z.string().min(1).max(500), minSilence: z.number().min(0.3).max(5).default(0.8) }),
  describe: (i) => `Remove silences from ${path.basename(i.file)}`,
  async run(i, ctx) {
    const file = resolveMedia(i.file);
    if (!VIDEO.test(file)) throw new Error("that isn't a video file (.mov, .mp4, .m4v)");
    return onMac("video_remove_silence")({ file, minSilence: i.minSilence }, ctx);
  },
});

export const mediaTranscribe = defineTool({
  name: "media_transcribe",
  tier: Tier.Read,
  untrustedOutput: true,
  description: "Transcribe the speech in a video or audio file, on this Mac. Returns the text with timestamps.",
  schema: z.strictObject({ file: z.string().min(1).max(500), language: z.string().max(10).default("en-IN") }),
  describe: (i) => `Transcribe ${path.basename(i.file)}`,
  async run(i, ctx) {
    const file = resolveMedia(i.file);
    if (!AUDIO_OR_VIDEO.test(file)) throw new Error("that isn't an audio or video file");
    return onMac("media_transcribe")({ file, language: i.language }, ctx);
  },
});

export const MEDIA_TOOLS = [imageCreate, screenRecordStart, screenRecordStop, videoTrim, videoCaptions, videoRemoveSilence, mediaTranscribe];
