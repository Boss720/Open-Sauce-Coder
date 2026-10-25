# HANDOFF.md

## 0. In flight — broad model harness audit (2026-10-25, branch `harness`)

Base: `dbb2e53` (quit-reap + DAG zoom fixes, not pushed). Spec: `.agents/teamwork/ORIGINAL_REQUEST.md`
(2026-10-05 block, R1–R4). Shared plumbing landed first (uncommitted): `ProviderReplay` on
`ChatMessage`/`ChatResponse` in `providers/adapter.ts`, copied onto the assistant message in
`runner.ts`, so adapters can echo Anthropic thinking signatures / Gemini thought signatures.

| Module | Files (exclusive) | Status |
|---|---|---|
| A Anthropic + OpenAI | `providers/anthropic.ts`, `providers/openai.ts`, new tests `harnessAnthropic.test.ts`, `harnessOpenAi.test.ts` | done, committed |
| B Gemini + OpenAI-compat | `providers/gemini.ts`, `openaiCompatible.ts`, `nanogpt.ts`, `thinkTagStreamer.ts`, new tests `harnessGemini.test.ts`, `harnessOpenAiCompat.test.ts` | done, committed |
| C Runner R2 | `runner.ts`, new test `harnessRunnerHardening.test.ts` | done, committed |
| D Panel/profiles/presets R4 | `HarnessPanel.tsx`, `profiles.ts` | done, committed |
| R3 tools | `tools/builtins.ts` (`fs_read` now says when it cuts at 2 MiB) | done, committed |

Gate at commit time: typecheck 0, lint 0, check:contracts PASS, 2623/2623 tests,
coverage 78.4/72.6/78.4/81.2 (gate 70/64/70/73).

Fixed: Anthropic `budget_tokens`/`temperature` 400s on Claude 4.7+/5.x (now adaptive thinking,
sampling only on <=4.6), thinking-signature replay, `refusal`, retry on 429/529/5xx, idle
timeout; OpenAI reasoning detection for GPT-5+ and `content: null`; Gemini thought-signature
replay, STOP+functionCall, unique call ids, thinkingLevel vs thinkingBudget; compat
`reasoning_content` echo (DeepSeek/Moonshot only), split `<think>` tags, keys never sent to
a foreign origin; runner executes tool calls on any finish reason, answers `length` cut-offs
without executing, races abort.

Open (not done):
- No live provider call made yet (spends quota) and no UI pass in the running app.
- `CUSTOM_API_KEY` for custom endpoints is read from `process.env` only — not in the BYOK
  allowlist/UI (pre-existing; needs keys.ts + CONTRACTS change).
- Gemini 3 history without stored signatures (e.g. imported from another provider) still 400s;
  dummy-signature bypass not implemented (docs page moved, unverified).
- Non-Anthropic presets partly stale (grok-2, moonshot-v1, cerebras llama3.3) — not verifiable
  without provider docs; OpenAI/Gemini/OpenRouter presets refreshed from the live OpenRouter list.
- Base URL field shows only for `custom`, not for built-in OpenAI-compatible providers.

Live smoke 2026-10-25 (keys from the user's `.env`, never stored): Anthropic blocked by
credit balance (400); gemini-3.5-flash and 2.5-flash completed a 5-turn tool run with
signature replay; gemini-3.8-flash works but takes 90-140 s per turn. Gemini 3 sends no
thought summaries when tools are attached, even with `thinkingLevel` set (provider
behaviour, not an adapter bug). `harness` pushed to sauce at `16174b2`.

### Wave 2 (done, 2026-10-25)

| Module | Files (exclusive) | Status |
|---|---|---|
| E Key-origin guard | `providers/anthropic.ts`, `providers/openai.ts`, `providers/openaiCompatible.ts` + their 3 test files | done, committed |
| F Gemini dummy signature | `providers/gemini.ts`, `harnessGemini.test.ts` | done, committed |
| G Base URL field + presets | `HarnessPanel.tsx`, `profiles.ts` | done, committed |

- E: Anthropic/OpenAI adapters sent the stored key to any `profile.baseUrl`; now only to
  their own origin (blank base URL = default). Compat providers may list
  `officialBaseUrls` (Moonshot `https://api.moonshot.ai/v1`).
- F: Gemini 3 turns with unsigned function calls get `skip_thought_signature_validator`
  on the first call. Live 2026-10-25, gemini-3.5-flash: unsigned 400, dummy 200.
- G: Base URL field for every provider whose adapter honours it (not google / nanogpt /
  opencode). Presets from live `/models` (Mistral, Cerebras) and official docs (xAI,
  Moonshot, DeepSeek). `deepseek-chat` / `deepseek-reasoner` / `moonshot-v1-*` /
  `grok-2` / `llama3.3-70b` / `mistral-large-latest` are gone; built-in profile
  `deepseek-reasoner` (id kept) now runs `deepseek-v4-pro`.
- UI pass in the dev app: xAI / Moonshot show the field with their default placeholder
  and the key hint, Google shows none, Custom keeps the Ollama placeholder.
- Gate: typecheck 0, lint 0, check:contracts PASS, 2664/2664 tests, coverage
  78.42/72.72/78.57/81.23.

Still open:
- `CUSTOM_API_KEY` in BYOK (security design call: via ALLOWLIST it would also enter the
  opencode child env).
- Groq presets unverified (the `.env` Groq key returns 401).
- Anthropic live call blocked on account credit.
- Anthropic/OpenAI requests follow redirects; a cross-host redirect would carry
  `x-api-key` (fetch strips only `Authorization`). Consider `redirect: 'error'`.

---

Written 2026-08-05, end of the release-hardening wave. Supersedes the wave-2 handoff
(2026-08-04), whose open follow-ups are carried forward in full below — none of them were
addressed by this wave.

Branch: `main` at `1a9dd56`, **pushed**. Tagged `v1.0.3`, **pushed**. GitHub Release
`v1.0.3` published with all four assets, verified via the API. Working tree clean.
Nothing in flight.

Release/tag drift on the 1.0.3 publish (assets first landed under a stray `v1.0.4`
release/tag) was **resolved on 2026-08-05** — see `docs/RELEASE_VERIFICATION.md`
§ "Incident — tag/release drift on the 1.0.3 publish". `/releases/latest` now resolves
`v1.0.3`; there is no `v1.0.4` tag on either side.

> **Read §4 before touching anything NanoGPT.** The vendored API reference on this machine
> documents the subscription-usage endpoint incorrectly, and following it is what produced
> a bug that survived two waves.

---

## 1. Where things stand

| Signal | Value | Re-check with |
|---|---|---|
| Version | 1.0.3 — `package.json` and tag agree | `node -p "require('./package.json').version"` |
| Typecheck | clean, node + web | `npm run typecheck` |
| Tests | **1584 passing / 86 files** | `npx vitest run` |
| Coverage | **72.54% stmts · 67.64% branch · 73.83% func · 75.53% lines** | `npx vitest run --coverage` |
| Coverage gate | thresholds 70/64/70/73 in `vitest.config.ts`, enforced by CI (`npm run test:coverage`) | forced-fail check, M2.6 |
| Contracts | PASS | `node scripts/check-contracts.mjs` |
| Lint | 0 errors, 89 warnings | `npx eslint .` |
| `npm audit` | **0 high** · 1 moderate · 1 low | `npm audit` |
| Build | `dist/OpenCode-Desktop-1.0.3-{setup,portable}.exe` + `latest.yml` + blockmap | `npm run dist:win` |
| Signing | **NotSigned** | `Get-AuthenticodeSignature dist\*.exe` |

The 89 lint warnings are all `no-explicit-any` and were the pre-existing wave-1 baseline —
this wave added none. Ratchet down from 89; do not treat it as a regression.

---

## 2. What this wave did

| Commit | What |
|---|---|
| `12355e5` | `chore:` 0.7.0 bump + `ROADMAP.md` (nine-module plan — **now partly stale, see §3**) |
| `f69903f` | `feat:` M1 — `CHANGELOG.md`, `scripts/release.mjs`, CI packaging job, crash-log readout in Settings (`oc:crashlog:read` bounded 64 KiB tail, `oc:crashlog:reveal`) |
| `5a652be` | `chore(deps):` M8 — cleared 3 high advisories, `@opencode-ai/sdk` 1.18.4 → 1.18.13, `npm audit --audit-level=high` CI gate |
| `03b6963` | `fix:` NanoGPT usage shape + global-shortcut recovery (§4) |
| `3fac850` | `fix:` rebase fallout — `StatusBar` and the quota-slice fixture onto the real usage shape |
| `a7ab838` | `chore:` version 1.0.2 |

**The histories had diverged.** Local `main` had forked at `b0bf8ff` (PR #4) before the
`feat/wave1-coverage` work; both sides then advanced. They were rebased together — nothing
from `V1.0.1` was dropped, nothing from this wave was dropped. `feat/release-hardening` and
the `backup/pre-rebase-main` safety ref have both been deleted.

**`V1.0.1` shipped with `"version": "0.6.0"` in `package.json`.** Tag and in-app version
disagreed, and `electron-updater` compares the package version, not the tag. Fixed by 1.0.2.
`scripts/release.mjs` exists specifically to stop this recurring — use `npm run release <v>`
rather than bumping by hand.

---

## 3. `ROADMAP.md` is stale — verified corrections

It was written against a snapshot predating the wave-1 branch. Do not plan from its status
column without re-checking.

| Roadmap claim | Reality on `main` |
|---|---|
| M5.1 permission profiles — not started | **Done** — `lib/permissionPresets.ts`, ask/workspace/auto, wired into Settings |
| M6.2 git status null on non-repo — not started | **Done** — `gitService.ts:416` returns null; branches returns `[]` |
| M7.3 persist UI state — not started | **Done** — `prefs.ts`, `sessionMeta.ts`, `tips.ts` |
| M2.5 slice coverage — 0/7 | **Mostly done** — event, session, prefs, nanoQuota, git, editor, agent, subagent, terminal, fileTree covered in earlier waves; `uiSlice`, `routingSlice`, `projectsSlice` and `imagesSlice` all at 100% statements *and* 100% branches, `compareSlice` at 99.31/95.86, as of 2026-08-05. Still low, measured that day: `api.ts` 53.84%, `gitSlice` 59.32%, `compare.ts` 82.35% |
| M8.1 fix dompurify by bumping monaco to 0.53.0 | **Wrong and harmful.** Tree is already on monaco 0.56.0 (latest stable), which still pins dompurify 3.4.8. `npm audit fix --force` would *downgrade* monaco three minors to "fix" a moderate. Do not run it |
| Coverage 50.39% / 810 tests / 62 files | 62.69% / 1099 tests / 72 files |

Rewriting `ROADMAP.md` against `main` is a good first task for a fresh session (§6).

---

## 4. NanoGPT — the documentation on this machine is wrong

`fetchSubscriptionUsage` parsed `daily` and `monthly` buckets. **The live API returns
neither.** It returns:

```
limits: { dailyInputTokens: null, weeklyInputTokens: <number>, dailyImages: <number> }
dailyInputTokens:  null                                          // null = no cap on this plan
weeklyInputTokens: { used, remaining, percentUsed, resetAt }
dailyImages:       { used, remaining, percentUsed, resetAt }
period:            { currentPeriodEnd: <ISO string> }
active, state, graceUntil, allowOverage, cancelAtPeriodEnd, provider, ...
```

**Why it survived two waves:** the vendored reference at
`C:\Users\Hp\llm-wiki\raw\# NanoGPT API Documentation Referen.md` line 188 documents this
endpoint as returning *"`active`, `limits.daily`, `daily.used`, `percentUsed`, `resetAt`,
`graceUntil`"*. That is the broken shape. Wave 2's commit `2ae4b3c` "conformed to the
published API" and left the usage parser wrong, because the published API description is
wrong. The vendored doc is still worth reading for other endpoints, but **it is not
authoritative — a live probe is.**

**How to capture a real payload** (this is the technique that finally worked):
temporarily `console.error` the payload's **keys and value types only, never values** —
it is account data — from inside `src/main/`, restart via the driver, read it back from
`%TEMP%\opencode-desktop-run\dev.err.log`, then remove the probe. One restart cycle.

The throw now names the payload's top-level keys, so the next shape change is diagnosable
from the error text alone without re-instrumenting.

**Open oddity, not our bug:** the API reports weekly tokens as
`34.6M used · 25.4M left · 1%`. Those three are not self-consistent and are passed through
unmodified. Confirm against the vendor before building anything on `percentUsed`.

**Key availability.** `%APPDATA%\opencode-desktop\byok-keys.json` holds `NANOGPT_API_KEY`
(plus Groq, Mistral, Cohere, OpenRouter, Cerebras, Moonshot, Gemini). Values look
`safeStorage`-encrypted, so decrypting them needs to happen inside Electron — a plain node
script cannot read them, and `process.env.NANOGPT_API_KEY` is unset. The in-app probe above
is the proven route. Note the image-model discovery endpoints (`/api/v1/image-models`,
`/api/v1/images/models`) need no key at all and can be curled directly.

---

## 5. Open work

### 5a. Carried forward from wave 2 — none of these were touched

1. **Boot-time NanoGPT key-load race.** On launch `oc:nanogpt:refresh` fails with
   `No NanoGPT API key is configured` while `oc:nanogpt:balance` succeeds moments later on
   the same account. Start at `server.ts` `doStart()` and `keys.ts` — the catalog refresh
   appears to run before the BYOK store is loaded.
2. **`readCache` / `readCacheSync` duplication** in `nanogptConfig.ts` — extract the shared
   parse step so only the I/O differs.
3. **Per-fetch limiter gating.** `refreshCatalogs()` fans out to two fetches that share one
   limiter slot; true gating means moving `acquireSlot()` into `nanogptConfig.ts`.
4. **`autoRotate` write is discarded.** `savePrefs` derives it from `routingMode` at
   `prefs.ts:142`, silently dropping caller-supplied values (`routingSlice.ts:60`). Pinned by
   a test documenting current behaviour; the fix is owed.
5. **Stall watchdog can never auto-retry** — `touchActiveAttempt` unconditionally sets
   `hasStreamed = true`. Possibly intentional; confirm intent before changing.
6. **`CONTRACTS.md` under-documents `applyEvent`** — four gaps, all now pinned by tests.

### 5b. Release-critical, this wave's leftovers

7. **M1.2 — updater round-trip. DONE, passed live twice on 2026-08-05** — `0.7.0 → 1.0.2`
   against the `v1.0.2` release, then `1.0.2 → 1.0.3` against the `v1.0.3` release.
   Evidence and residual gaps are in `docs/RELEASE_VERIFICATION.md` §§ "Live result #1"
   and "#2". The 0.7.0 artifacts that served as the first "old" install were deleted
   from `dist/`.
   Standing caveat: `updater.ts` sets no `publisherName` and builds are unsigned, so
   electron-updater *skips* signature verification rather than failing. Integrity rests
   only on the `sha512` in `latest.yml` — which verified on both runs.
   **Blockmap differential download: PROVEN 2026-08-05.** 30 changed blocks, 619 KB
   transferred against a 127,803 KB artifact (0.48%), reconstructed byte-exact. Evidence
   in `docs/RELEASE_VERIFICATION.md` § "Differential download — proven". Both GitHub hops
   fetched full because the delta base (`<updater-cache>/installer.exe`) is written by the
   NSIS installer, and the cache was empty on the first hop.
   `src/main/updater.ts` now carries an opt-in file logger — set `OPENCODE_UPDATER_LOG` to
   a path to capture updater diagnostics; it stays off otherwise because the lines contain
   update URLs and local paths.
8. **M1.1 — code signing.** Blocked on buying an OV/EV cert or Azure Trusted Signing, not a
   code problem. Until then SmartScreen warns every first-time user.
9. **M8.4 — Dependabot/Renovate**, grouped weekly. Small; the audit gate already catches what
   it would raise.

### 5c. Quality, highest value first

10. **M2.3 — IPC-boundary tests. DONE 2026-08-05.** All 71 registered channels covered by
    290 tests across 7 files. `ipc.ts` went 5.76% → **74.89% branch**, 21.27% → 90.9%
    statements; repo-wide 59.66% → 63.07% branch, 62.69% → **68.07% statements**.
    Harness: `src/main/__tests__/ipcHarness.ts` (stub `ipcMain`, all 20 collaborators
    mocked via `vi.doMock` + dynamic import — top-level `vi.mock` will not hoist across
    files, so reuse `loadIpc()` rather than rolling your own). Findings and the
    channel-diff caveat live in `docs/plans/m2.3-ipc-boundary/SPEC.md`.
    One open finding: MCP handlers validate `args.directory` but pass `args.name` /
    `args.config` to the service layer unvalidated (`ipc.ts:777-805`). Current behaviour
    is pinned by tests; the fix is owed.
11. **M2.4 — main files with no tests at all:** `index.ts`, `server.ts`, `tray.ts`,
    `menu.ts`, `quickEntry.ts`, `liveWindow.ts`. (`updater`, `crashlog`, `nanogptLimiter`,
    `tokenBudgetTracker` now have tests.)
12. **M2.1 — Playwright E2E.** `e2e/` does not exist.
13. **M2.2 — component tests.** `components/__tests__/` does not exist.
14. **M2.6 — coverage gate. DONE 2026-08-05.** Thresholds live in `vitest.config.ts`:
    statements 65 / branches 60 / functions 65 / lines 68, against measured 68.07 / 63.07
    / 68.51 / 71.19. CI now runs `npm run test:coverage` instead of `npm run test`, so the
    gate is enforced rather than merely measurable. Verified in both directions locally —
    green at the real numbers, and red with the documented error when a threshold is not
    met. **Ratchet these upward as coverage lands; never lower them to make a build pass.**
15. **M4.1 — keyboard collision.** `MentionMenu.tsx:66` still registers a global
    capture-phase `keydown` racing `Chat.tsx` and `Composer.tsx`. Real bug, cheap fix, needs
    a regression test.
16. **M3.1 — split `ipc.ts`** (now 1307 lines; it grew). **Only after #10** — refactoring an
    untested boundary is how a working app breaks.

### Size hotspots

```
main:       ipc.ts 1307 · gitService.ts 817 · nanogpt.ts 611 · fsService.ts 559 · server.ts 556
components: SettingsPanel 827 · CommandPalette 707 · MessageView 678 · ProviderPanel 658 · ToolCall 608
css:        index.css 2166 · messages.css 1713
```

---

## 6. Subagent deployment

### Fan out only across non-overlapping files. Everything else is sequential.

| Task shape | Model | Notes |
|---|---|---|
| Read-only audit, one module each | haiku | 4 in parallel worked well — cheap, fast |
| Single-file mechanical edit (YAML, config, rename) | haiku | Works, but read its output — see failures below |
| Multi-file change needing typecheck/test iteration | sonnet | Reliable **when handed evidence**, not asked to find it |
| Anything touching `package.json` / `package-lock.json` | sonnet, **exactly one** | Never parallel — one lockfile, two writers corrupts it |
| Judgment: what to do, conflict resolution, verifying claims | main thread | Do not delegate |

### Prompt template that produced good results

```
Repo: C:\Users\Hp\Dev\opencode-desktop. Do NOT git commit — leave changes in the
working tree. Do not touch <files another agent owns>.

CONTEXT: <hard evidence already gathered — captured payloads, file:line anchors,
exact error strings. Never make the agent rediscover these.>

TASK: <numbered, specific, with reasoning for non-obvious choices>

CONSTRAINTS: match surrounding code style and comment density; no `any`; no scope
creep; if you think <X> should change, report the recommendation instead of doing it.

VERIFY and paste the real output for each:
  npm run typecheck
  node scripts/check-contracts.mjs
  npx vitest run       (baseline 1099/72 — report the real number)
  npx eslint .         (baseline 0 errors, 89 warnings)

Report: per-file changes, the four verification outputs with real numbers, and
anything you deliberately did NOT do and why.
```

Quoting the baselines matters — it converts "tests pass" into a checkable claim.

### Observed failure modes — across both waves, agents report confidently and are sometimes wrong

- **Fabricated a fact in a code comment.** A haiku agent wrote that PRs could "add to the
  allowlist" for the audit gate. No such mechanism exists. Read every comment an agent
  writes — comments assert things to future readers.
- **Solved the wrong problem.** A sonnet agent was asked to fix the NanoGPT error without
  being given evidence of its cause, and made the parser tolerant instead. The real bug was
  a total field-name mismatch. See §4.
- **Claimed "verified" from a file re-read** because its agent type had no shell, and had
  left an unwanted line behind (wave 2).
- **Wrote a test that passed for the wrong reason** — asserted a released slot frees a
  *time*-based window, green only because `runAllTimersAsync` skipped ahead (wave 2).
- **Reported no API key existed** at a path where one did (wave 2).
- **Do not delegate mid-rebase.** Conflict state is fragile; resolve on the main thread.

**Always re-run typecheck / tests / lint yourself before committing.** Every agent claim
this wave was independently re-verified; one was wrong.

### Good first task for a fresh session

Re-audit `ROADMAP.md` against `main` and rewrite it (§3). Three haiku agents in parallel —
M1/M8, M2, M3/M4 — each told to cite `file:line` and run read-only commands only.

---

## 7. Environment gotchas

**Running the app** — always
`powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start`. Never a bare
`npm run dev`. Always `stop` when finished.

- A stale instance silently hijacks the run and leaves the *old* window on screen looking
  like your build. `start` failed twice this session; the fix was `stop`, `stop` again, then
  `start`. An orphaned `opencode serve` holding port 4599 survives an electron kill and is
  the usual cause.
- `starting electron app...` in `dev.out.log` is **not** the ready signal — wait for
  `[vite] connected.`.
- The window can vanish to the tray mid-session (`closeToTray` defaults on); the driver then
  reports "dev window not found".

**Screenshots and clicking** — `request_access(["electron.exe"])` for the dev build. For a
**packaged portable** build the exe re-extracts to a fresh `%TEMP%\<random>\` on *every
launch*, so a prior grant does not carry over — re-request each run or the window is masked.
Focus is contested: `driver.ps1 shot -KeepTop`, then `focus`, then act, then `release`.

**Driving the UI mutates real state.** `app-settings.json` changed mid-session and I wrongly
concluded I had caused it. Check the mtime of
`%APPDATA%\opencode-desktop\app-settings.json` before drawing conclusions, and ask before
"restoring" any user setting.

**Two constants are duplicated across the process boundary** — `WEEKLY_INPUT_TOKEN_CAP` and
`DAILY_FREE_IMAGE_CAP` live in both `src/main/` and `src/renderer/src/lib/types.ts`, because
the renderer cannot import modules pulling in Electron `app` or node `fs`.
`scripts/check-contracts.mjs` fails the build if they diverge — change both sides. The same
applies to `NanoUsage`, which is declared in four places.

**All `index.json` mutations must go through `withIndexLock`** in `nanogptImages.ts`. The
unlocked version lost 3 of 5 concurrent saves.

**Wave-2 module specs** are at `docs/plans/nanogpt-wave2/`; `00-CONTRACT.md` remains the
reference for the main/preload/renderer seams.

**Shell** — PowerShell on Windows. Write commit messages to a temp file and use
`git commit -F <file>`; never PowerShell here-strings inside a bash call. No
`Co-Authored-By` trailers. **`gh` is not installed** — there is no CLI path to creating or
merging a PR. Push a branch and hand over a compare URL, or merge locally and push.

**Disk** — C: has ~18 GB free. Each `npm run dist:win` writes ~250 MB into `dist/`.

---

## 8. Exact next command

```bash
git -C C:/Users/Hp/Dev/opencode-desktop log --oneline -3
```

Confirm the tree is clean. M1.2 (updater round-trip), M2.3 (IPC-boundary tests), M2.5
(uiSlice / routingSlice / projectsSlice) and M2.6 (coverage gate) are all **done** — see
§5b item 7 and `ROADMAP.md`. M1.1 code signing is blocked on buying a cert.

Unblocked work, in order:

1. **Finish M2.5.** Remaining low-coverage modules, worst first: `slices/api.ts` 53.84%,
   `gitSlice.ts` 59.32%, `compare.ts` 82.35%. Ratchet the `vitest.config.ts` thresholds up
   as each lands — they are now 70/64/70/73 against measured 72.54/67.64/73.83/75.53.
   Note `compareSlice.ts:346` (`default: return false` in `applyCompareEvent`) is
   unreachable: `isColumnEvent` admits exactly eight event types and all eight have cases.
   It is defensive only — do not contort a test to reach it.
2. **Validate MCP handler arguments** — `src/main/ipc.ts:777-805` validates
   `args.directory` but passes `args.name` and `args.config` through unchecked. The M2.3
   tests pin the current behaviour; they do not make it correct. Recorded in
   `docs/plans/m2.3-ipc-boundary/SPEC.md` § Findings.
3. **Decide `feat/p3-code-surface`** — unmerged, 2 commits ahead. `933329c` is preserved
   by tag `v0.7.0`; only `26f227b` ("WIP: epitaxy pre-switch") would become unreachable,
   so deletion needs `git branch -D`. Owner's call.
