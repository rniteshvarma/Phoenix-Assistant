import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, scryptSync,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { PhoenixConfig } from "../config.ts";
import type { SettingsStore } from "../proactive/schedule.ts";

/**
 * Encrypted backups of everything Phoenix knows: the database (memory, profile, skills, history,
 * settings, the Privacy Shield vault) plus the master key that unlocks it, and Phoenix's notes.
 *
 * Each backup is encrypted to a backup public key (X25519 → HKDF → AES-256-GCM), so nightly
 * backups run without asking for anything. The matching private key is sealed with the user's
 * passphrase (scrypt) and carried inside every backup, so restoring needs only the file and the
 * passphrase, even on a new Mac. Phoenix never stores the passphrase.
 */

const MAGIC = Buffer.from("PHXBAK1\n");
const INFO = "phoenix-backup-v1";
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };

export interface Sealed { salt: string; iv: string; tag: string; ct: string }

export interface BackupSettings {
  dir: string;
  nightly: boolean;
  keep: number;
  /** Backup public key (SPKI DER, base64) and its private key sealed with the passphrase. */
  publicKey?: string;
  sealedPrivate?: Sealed;
  lastBackup?: number;
  lastFile?: string;
  lastError?: string;
}

export function defaultBackupDir(home = os.homedir()): string {
  const icloud = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  return fs.existsSync(icloud) ? path.join(icloud, "Phoenix Backups") : path.join(home, "Documents", "Phoenix Backups");
}

export function backupSettings(settings: SettingsStore): BackupSettings {
  return { dir: defaultBackupDir(), nightly: true, keep: 14, ...settings.get<Partial<BackupSettings>>("backup", {}) };
}

export function updateBackupSettings(settings: SettingsStore, patch: Partial<BackupSettings>): BackupSettings {
  const next = { ...backupSettings(settings), ...patch };
  settings.set("backup", next);
  return next;
}

function passKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, SCRYPT);
}

function seal(key: Buffer, data: Buffer, salt: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function unseal(key: Buffer, s: Sealed): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
}

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < 12) return "use at least 12 characters (a short sentence works well)";
  if (/^(.)\1+$/.test(passphrase)) return "that passphrase is too easy to guess";
  return null;
}

/** Create (or replace) the backup key, sealing its private half with the passphrase. */
export function setupBackupKey(settings: SettingsStore, passphrase: string): void {
  const problem = checkPassphrase(passphrase);
  if (problem) throw new Error(problem);
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const salt = randomBytes(16);
  const sealedPrivate = seal(passKey(passphrase, salt), privateKey.export({ type: "pkcs8", format: "der" }), salt);
  updateBackupSettings(settings, {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sealedPrivate,
  });
}

interface Payload {
  version: 1;
  createdAt: number;
  db: string;
  master: string;
  files: Record<string, string>;
}

function readDirFiles(dir: string, prefix: string, out: Record<string, string>): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile() && fs.statSync(full).size < 20 * 1024 * 1024) out[`${prefix}/${name}`] = fs.readFileSync(full).toString("base64");
  }
}

/** Write one encrypted backup; returns its path. `master` is the raw 32-byte master key. */
export function createBackup(cfg: PhoenixConfig, settings: SettingsStore, master: Buffer, now = Date.now()): string {
  const s = backupSettings(settings);
  if (!s.publicKey || !s.sealedPrivate) throw new Error("set a backup passphrase first");
  fs.mkdirSync(s.dir, { recursive: true });

  // A consistent copy of the live database.
  const snap = path.join(cfg.home, `.backup-snapshot-${process.pid}.db`);
  fs.rmSync(snap, { force: true });
  const db = new DatabaseSync(cfg.dbPath);
  try {
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const files: Record<string, string> = {};
  readDirFiles(cfg.notesDir, "notes", files);
  readDirFiles(cfg.outboxDir, "outbox", files);
  const payload: Payload = { version: 1, createdAt: now, db: fs.readFileSync(snap).toString("base64"), master: master.toString("hex"), files };
  fs.rmSync(snap, { force: true });

  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: Buffer.from(s.publicKey, "base64"), format: "der", type: "spki" }) });
  const salt = randomBytes(16);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
  const body = seal(key, gzipSync(Buffer.from(JSON.stringify(payload))), salt);
  const header = Buffer.from(JSON.stringify({
    v: 1, createdAt: now,
    eph: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    salt: body.salt, iv: body.iv, tag: body.tag,
    publicKey: s.publicKey, sealedPrivate: s.sealedPrivate,
  }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);

  const stamp = new Date(now).toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = path.join(s.dir, `phoenix-backup-${stamp}.phx`);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.concat([MAGIC, len, header, Buffer.from(body.ct, "base64")]), { mode: 0o600 });
  fs.renameSync(tmp, file);

  // Keep the newest `keep` backups.
  const all = fs.readdirSync(s.dir).filter((f) => /^phoenix-backup-.*\.phx$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - s.keep))) fs.rmSync(path.join(s.dir, old), { force: true });

  updateBackupSettings(settings, { lastBackup: now, lastFile: file, lastError: undefined });
  return file;
}

export interface RestoredBackup {
  createdAt: number;
  db: Buffer;
  master: Buffer;
  files: Record<string, Buffer>;
}

/** Decrypt a backup file with the passphrase. Throws on a wrong passphrase or a damaged file. */
export function openBackup(file: string, passphrase: string): RestoredBackup {
  const raw = fs.readFileSync(file);
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("that isn't a Phoenix backup file");
  const hlen = raw.readUInt32BE(MAGIC.length);
  const header = JSON.parse(raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + hlen).toString()) as {
    eph: string; salt: string; iv: string; tag: string; sealedPrivate: Sealed;
  };
  const ct = raw.subarray(MAGIC.length + 4 + hlen);
  let privateDer: Buffer;
  try {
    privateDer = unseal(passKey(passphrase, Buffer.from(header.sealedPrivate.salt, "base64")), header.sealedPrivate);
  } catch {
    throw new Error("wrong passphrase for this backup");
  }
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.from(header.eph, "base64"), format: "der", type: "spki" }),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(header.salt, "base64"), INFO, 32));
  let plain: Buffer;
  try {
    plain = unseal(key, { salt: header.salt, iv: header.iv, tag: header.tag, ct: ct.toString("base64") });
  } catch {
    throw new Error("this backup file is damaged or was changed");
  }
  const p = JSON.parse(gunzipSync(plain).toString()) as Payload;
  return {
    createdAt: p.createdAt,
    db: Buffer.from(p.db, "base64"),
    master: Buffer.from(p.master, "hex"),
    files: Object.fromEntries(Object.entries(p.files).map(([k, v]) => [k, Buffer.from(v, "base64")])),
  };
}

/** Put a restored backup in place. The current database is kept aside, never deleted. */
export function applyBackup(cfg: PhoenixConfig, b: RestoredBackup, writeMaster: (master: Buffer) => void, now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const aside = `${cfg.dbPath}.before-restore-${stamp}`;
  if (fs.existsSync(cfg.dbPath)) fs.renameSync(cfg.dbPath, aside);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(cfg.dbPath + ext)) fs.renameSync(cfg.dbPath + ext, aside + ext);
  fs.writeFileSync(cfg.dbPath, b.db, { mode: 0o600 });
  writeMaster(b.master);
  for (const [rel, data] of Object.entries(b.files)) {
    const [folder, name] = rel.split("/");
    const dir = folder === "notes" ? cfg.notesDir : folder === "outbox" ? cfg.outboxDir : null;
    if (!dir || !name || name.includes("..")) continue;
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, data, { mode: 0o600 });
  }
  return aside;
}

/** Nightly: back up once a day, whenever the core is running. */
export function backupDue(s: BackupSettings, now = Date.now()): boolean {
  return s.nightly && !!s.publicKey && (!s.lastBackup || now - s.lastBackup > 24 * 3600_000);
}
