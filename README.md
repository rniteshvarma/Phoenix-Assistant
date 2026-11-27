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

## Status: Phase 1 — Mac voice, Summon Bar & memory (in progress)

| Piece | Where |
|---|---|
| Streaming replies (first sentence spoken before the answer is finished) | `core/src/agent/model.ts` |
| Web search (weather, news, hours) via Claude's server-side search | `core/src/agent/model.ts` |
| Conversations that continue for 30 min, append-only history | `core/src/store/sessions.ts` |
| Memory ("remember…"), refuses passwords/cards/Aadhaar/PAN/OTPs | `core/src/store/memory.ts`, `core/src/tools/memory.ts` |
| Calendar (read-only, runs in the Mac app via EventKit) | `core/src/tools/calendar.ts`, `apps/mac/…/Native.swift` |
| Local gateway: token auth, loopback only, browsers refused | `core/src/gateway/` |
| Mac app: menu bar flame, ⌥Space, Summon Bar, Touch ID approvals | `apps/mac/` |
| "Phoenix, rise" wake phrase + on-device speech recognition + spoken replies | `apps/mac/Sources/Phoenix/VoiceListener.swift`, `Speaker.swift` |

### API keys (saved once, in your Keychain)

```bash
npm run phoenix -- key set        # save or replace your Anthropic key (typing is hidden)
npm run phoenix -- key            # which key is in use, and does Anthropic still accept it?
npm run phoenix -- key remove     # delete it
```

Phoenix reads the key from the macOS Keychain itself, so every new terminal just works. When a key expires or is revoked, Phoenix says so and `key set` replaces it. An `ANTHROPIC_API_KEY` set in a terminal still takes priority for that terminal.

### Privacy Shield

Sensitive data never leaves your Mac. Before anything is sent to Claude (or a cloud voice), Phoenix scans it **on the Mac** and swaps IDs (Aadhaar, PAN, passport, driving licence), bank/card/UPI details, email addresses, phone numbers, passwords, PINs, OTPs and keys for placeholders like `[[PAN_1]]`; the real values stay in an encrypted vault on the Mac. You still see real values on screen. Any action that would send protected data off the Mac asks you **twice** ("Are you sure?"), with Touch ID. Images and PDFs are read on the Mac with Apple's on-device text recognition; ID cards, passports and bank/card statements are treated as **confidential** — Phoenix only learns what kind of document it is. Check any file with `npm run phoenix -- scan <file>`. Code: `core/src/privacy/`.

### Run it every day (starts automatically)

```bash
npm run phoenix -- key set          # once: save your Anthropic key in the Keychain
apps/mac/build.sh                    # once (and after app changes): build the Mac app + on-device text reader
npm run phoenix -- autostart on      # start the core + open the app at every login
npm run phoenix -- autostart         # status: running? key saved? recent log lines
```

The core runs in the background (log: `~/Library/Logs/Phoenix/core.log`) and restarts if it stops.
`autostart restart` restarts it (e.g. after `key set`); `autostart off` turns it all off.
If the core is ever offline, the menu bar flame offers **Start Phoenix core**.

### Talking to Phoenix

- Say **"Phoenix, rise"**, then your request — or press **⌥Space**, or click the keyboard icon to type.
- While Phoenix is speaking, say **"Phoenix, stop"** (or "stop, Phoenix", "Phoenix, quiet") to silence it and cancel what it's doing. You can also press **Esc**, **⌥Space** or the **Stop** button.
- Speech is recognised on the Mac; if on-device dictation isn't installed, turn on Dictation in System Settings › Keyboard.

Approvals in the app require Touch ID (or your Mac password). Each rebuild of the app is a new ad-hoc signature, so macOS may ask for permissions again.

Terminal conversation with memory: `npm run phoenix -- chat`. See and delete what Phoenix remembers: `npm run phoenix -- memory`.

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
