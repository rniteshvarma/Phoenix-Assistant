# Phoenix

A private, voice-first personal agent for your Mac and iPhone. Phoenix plans and does the work; **you approve anything that leaves your device, costs money, or can't be undone.**

Full plan: [docs/PHOENIX_EXECUTION_PLAN.md](docs/PHOENIX_EXECUTION_PLAN.md)

## Status: Phase 0 — foundations & security skeleton ✅

| Piece | Where |
|---|---|
| Risk tiers (T0 read → T3 money) | `core/src/policy/tiers.ts` |
| Policy engine (deterministic gate, blocked tools) | `core/src/policy/engine.ts` |
| Approval tokens bound to the exact payload (HMAC, single-use, 10-min expiry) | `core/src/policy/approvals.ts` |
| Guarded executor (only path to running a tool) | `core/src/policy/executor.ts` |
| Hash-chained, encrypted, append-only audit log | `core/src/audit/log.ts` |
| Encrypted task store (AES-256-GCM, key in macOS Keychain) | `core/src/store/`, `core/src/security/` |
| Agent loop (Claude Opus 5.5, untrusted-content wrapping, step limit, cancel) | `core/src/agent/loop.ts` |
| Tools: `notes_save` (T1), `notes_list`/`notes_read` (T0), `outbox_send` (T2, simulated) | `core/src/tools/builtin.ts` |
| CLI with terminal approval cards | `core/src/cli/` |

## Run it

Requires Node.js 24+ (uses built-in TypeScript type stripping and `node:sqlite`).

```bash
npm install
```

Offline demo (scripted model, no API key, nothing leaves the Mac):

```bash
npm run phoenix -- --offline "draft a note to myself and save it"
```

With Claude:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run phoenix -- "save a note with my packing list for Goa, then email it to me"
```

Audit log:

```bash
npm run phoenix -- audit
npm run phoenix -- audit verify
```

Tests and type-check:

```bash
npm test && npm run typecheck
```

## Where data lives

`~/Library/Application Support/Phoenix/` (override with `PHOENIX_HOME`): `phoenix.db` (encrypted columns), `notes/`, `outbox/`. Folders are `0700`, files `0600`. The master key is stored in the macOS Keychain under `dev.phoenix.master-key` (set `PHOENIX_KEY_BACKEND=file` to use a `0600` key file instead, e.g. for tests).
