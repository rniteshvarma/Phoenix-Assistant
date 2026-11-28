import fs from "node:fs";
import { applyBackup, backupSettings, checkPassphrase, createBackup, openBackup, setupBackupKey, updateBackupSettings } from "../backup/backup.ts";
import type { Phoenix } from "../phoenix.ts";
import { loadMasterKey, writeMasterKey } from "../security/keys.ts";
import { c } from "./style.ts";

/** Read a line from the terminal without echoing it. */
export function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("run this in a terminal (the passphrase is typed hidden)"));
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function coreRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PHOENIX_PORT ?? 7788}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** `phoenix backup [status|setup|now|restore <file>|dir <path>|nightly on|off]` */
export async function backupCommand(phoenix: Phoenix, args: string[]): Promise<number> {
  const [action = "status", ...rest] = args;
  const out = (s: string) => process.stdout.write(s);
  try {
    switch (action) {
      case "status": {
        const s = backupSettings(phoenix.settings);
        out([
          "",
          `  ${s.publicKey ? c.green("✓ Backups are set up") : c.amber("– No backup passphrase yet: npm run phoenix -- backup setup")}`,
          `  ${c.dim("Where")}      ${s.dir}`,
          `  ${c.dim("Nightly")}    ${s.nightly ? "on" : "off"} ${c.dim(`(keeps the newest ${s.keep})`)}`,
          `  ${c.dim("Last")}       ${s.lastBackup ? `${new Date(s.lastBackup).toLocaleString()}  ${c.dim(s.lastFile ?? "")}` : "never"}`,
          s.lastError ? `  ${c.red("Last error")} ${s.lastError}` : "",
          "",
        ].filter(Boolean).join("\n") + "\n");
        return 0;
      }
      case "setup": {
        out(`\n  Choose a backup passphrase. ${c.bold("Write it down somewhere safe")}: without it, backups can't be opened by anyone, including you.\n`);
        const p1 = await readHidden("  Passphrase: ");
        const problem = checkPassphrase(p1);
        if (problem) throw new Error(problem);
        const p2 = await readHidden("  Again: ");
        if (p1 !== p2) throw new Error("the two passphrases don't match");
        setupBackupKey(phoenix.settings, p1);
        const file = createBackup(phoenix.cfg, phoenix.settings, loadMasterKey(phoenix.cfg));
        out(`  ${c.green("✓")} Backups set up. First backup: ${file}\n`);
        return 0;
      }
      case "now": {
        const file = createBackup(phoenix.cfg, phoenix.settings, loadMasterKey(phoenix.cfg));
        out(`  ${c.green("✓")} Backed up to ${file}\n`);
        return 0;
      }
      case "dir": {
        if (!rest[0]) throw new Error("usage: phoenix backup dir <folder>");
        updateBackupSettings(phoenix.settings, { dir: rest.join(" ") });
        out(`  ${c.green("✓")} Backups will go to ${rest.join(" ")}\n`);
        return 0;
      }
      case "nightly": {
        updateBackupSettings(phoenix.settings, { nightly: rest[0] !== "off" });
        out(`  ${c.green("✓")} Nightly backups ${rest[0] === "off" ? "off" : "on"}\n`);
        return 0;
      }
      case "restore": {
        const file = rest.join(" ");
        if (!file || !fs.existsSync(file)) throw new Error("usage: phoenix backup restore <backup file>");
        if (await coreRunning()) {
          throw new Error("stop the background core first: npm run phoenix -- autostart off  (then turn it back on after restoring)");
        }
        const passphrase = await readHidden("  Backup passphrase: ");
        const backup = openBackup(file, passphrase);
        out(`  Backup from ${new Date(backup.createdAt).toLocaleString()}. This replaces Phoenix's current memory, skills, history and settings.\n`);
        const answer = await readHidden(`  Type ${c.bold("restore")} to continue: `);
        if (answer.trim().toLowerCase() !== "restore") {
          out("  Cancelled.\n");
          return 1;
        }
        phoenix.close();
        const aside = applyBackup(phoenix.cfg, backup, (m) => writeMasterKey(phoenix.cfg, m));
        out(`  ${c.green("✓")} Restored. Your previous database is kept at ${aside}\n  Start Phoenix again: npm run phoenix -- autostart on\n`);
        return 0;
      }
      default:
        process.stderr.write("  Usage: phoenix backup [status|setup|now|restore <file>|dir <folder>|nightly on|off]\n");
        return 2;
    }
  } catch (err) {
    process.stderr.write(`  ${c.red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
