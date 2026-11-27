import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KIND_LABEL, detect, type Kind } from "./detect.ts";
import type { PrivacyVault } from "./vault.ts";

const run = promisify(execFile);

/**
 * Reading documents (images and PDFs) without letting confidential ones leave the Mac.
 *
 * Text is extracted on the Mac (PDF text layer, or Apple Vision OCR via `phoenix-ocr`).
 * Documents that are themselves confidential — ID cards, passports, bank statements,
 * card statements — are never passed on: Phoenix only learns what kind of document it is
 * and gets placeholders for the protected numbers in it (each needs approval twice to use).
 * Other documents pass through the Privacy Shield like any text.
 */

export const DOCUMENT_TYPES = [
  { name: "Aadhaar card", re: /\baadh?aa?r\b|unique identification authority|\buidai\b|आधार/i },
  { name: "PAN card", re: /income tax department|permanent account number/i },
  { name: "passport", re: /\bpassport\b|republic of india.*(?:type|code)|P<[A-Z]{3}/i },
  { name: "driving licence", re: /driving licen[cs]e|\blicen[cs]e to drive\b/i },
  { name: "voter ID", re: /election commission of india|elector'?s photo identity/i },
  { name: "bank statement", re: /statement of account|account statement|\bpassbook\b/i },
  { name: "card statement", re: /credit card statement|card statement|minimum amount due/i },
] as const;

/** Protected kinds that make a whole document confidential on their own. */
const CONFIDENTIAL_KINDS = new Set<Kind>([
  "AADHAAR", "PAN", "PASSPORT", "DRIVING_LICENCE", "CARD", "CVV", "BANK_ACCOUNT", "PASSWORD", "PRIVATE_KEY", "API_KEY",
]);

export interface Classification {
  confidential: boolean;
  /** e.g. "Aadhaar card", if recognised. */
  docType?: string;
  kinds: Kind[];
}

/** Decide whether extracted text is a confidential document. Pure, so it can be tested. */
export function classifyDocument(text: string): Classification {
  const kinds = [...new Set(detect(text).map((f) => f.kind))];
  const docType = DOCUMENT_TYPES.find((d) => d.re.test(text))?.name;
  const confidential = docType !== undefined || kinds.some((k) => CONFIDENTIAL_KINDS.has(k));
  return { confidential, docType, kinds };
}

export interface DocumentScan extends Classification {
  file: string;
  pages: number;
  method: "text" | "ocr" | "mixed";
  /** What Phoenix may pass on: protected text, or for a confidential document only a description. */
  shareable: string;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp", ".webp"]);
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log"]);
export const SUPPORTED = [...IMAGE_EXT, ".pdf", ...TEXT_EXT];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function ocrBinary(env = process.env): string {
  return env.PHOENIX_OCR ?? path.join(REPO_ROOT, "apps", "mac", "build", "phoenix-ocr");
}

/** Folders Phoenix may read documents from. Everything else (e.g. ~/Library) is off limits. */
export function allowedRoots(home = os.homedir()): string[] {
  return ["Documents", "Desktop", "Downloads"].map((d) => path.join(home, d));
}

export function resolveAllowed(file: string, roots = allowedRoots()): string {
  const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
  const full = path.resolve(expanded);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new Error(`no such file: ${path.basename(full)}`);
  }
  const inside = roots.some((root) => {
    const rel = path.relative(fs.existsSync(root) ? fs.realpathSync(root) : root, real);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!inside) throw new Error("Phoenix can only read documents in Documents, Desktop or Downloads");
  return real;
}

/** Tidy extracted text: drop image markers (U+FFFC), decode common HTML entities, squeeze blank runs. */
export function cleanText(text: string): string {
  return text
    .replace(/\uFFFC/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract text on this Mac: plain text directly, images/PDFs through phoenix-ocr. */
export async function extractText(file: string): Promise<{ text: string; pages: number; method: DocumentScan["method"] }> {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  if (fs.statSync(file).isDirectory()) throw new Error(`That's a folder, not a file: ${file}`);
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    return { text: fs.readFileSync(file, "utf8").slice(0, 200_000), pages: 1, method: "text" };
  }
  if (!IMAGE_EXT.has(ext) && ext !== ".pdf") {
    throw new Error(`unsupported file type ${ext || "(none)"}; supported: ${SUPPORTED.join(" ")}`);
  }
  const bin = ocrBinary();
  if (!fs.existsSync(bin)) throw new Error("the on-device text reader isn't built yet; run apps/mac/build.sh");
  let stdout: string;
  try {
    ({ stdout } = await run(bin, [file], { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }));
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`Couldn't read ${path.basename(file)}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = JSON.parse(stdout) as { pages: Array<{ text: string; method: "text" | "ocr" }> };
  const methods = new Set(parsed.pages.map((p) => p.method));
  return {
    text: parsed.pages.map((p) => p.text).join("\n\n"),
    pages: parsed.pages.length,
    method: methods.size > 1 ? "mixed" : (parsed.pages[0]?.method ?? "ocr"),
  };
}

/** Read a document and decide what of it may leave the Mac. */
export async function scanDocument(file: string, vault: PrivacyVault): Promise<DocumentScan> {
  const extracted = await extractText(file);
  const { pages, method } = extracted;
  const text = cleanText(extracted.text);
  const cls = classifyDocument(text);
  const protectedText = vault.protect(text);
  const name = path.basename(file);

  let shareable: string;
  if (cls.confidential) {
    const placeholders = [...new Set(protectedText.text.match(/\[\[[A-Z_]+_\d+\]\]/g) ?? [])]
      .filter((t) => CONFIDENTIAL_KINDS.has(t.slice(2, t.lastIndexOf("_")) as Kind))
      .map((t) => `${t} (${KIND_LABEL[t.slice(2, t.lastIndexOf("_")) as Kind]})`);
    shareable = [
      `"${name}" is a confidential document${cls.docType ? ` (${cls.docType})` : ""}.`,
      "Its contents stay on this Mac: they can't be read out, summarised to the cloud, attached or sent.",
      placeholders.length > 0
        ? `Protected values in it: ${placeholders.join(", ")}. Using any of them requires the user's approval twice.`
        : "",
      "Tell the user what kind of document it is and ask what they need.",
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    shareable = protectedText.text.trim() || `"${name}" has no readable text.`;
  }
  return { ...cls, file: name, pages, method, shareable };
}
