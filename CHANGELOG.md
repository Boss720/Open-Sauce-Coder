# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-24

### Added

- Multi-provider agentic harness: agent profiles, a tool registry and single-agent runs
  alongside `opencode serve`.
- Multi-agent DAG workflow engine (waves, conditions, abort-on-fail) with the DagPanel graph
  view, node drawer and built-in workflow templates.
- Copper Focus UI, free model routing, the harness policy broker and the Leroy sidecar.
- Opt-in updater log, with the differential download proven end to end.

### Changed

- The update feed and project links moved to `Boss720/Open-Sauce-Coder`. Installs of 1.0.3
  or earlier keep checking the previous repository.
- The main window is created hidden and shown on `ready-to-show`, without the always-on-top
  toggle that stole focus on tray and second-instance shows.

### Fixed

- DAG workflows load by project directory and id only, never from a renderer-supplied path.
- DAG node failures are no longer swallowed, and stranded nodes fail the run.
- The OpenCode bridge completes without relying on `session.idle`, no longer echoes the
  prompt, and rejects requests that carry harness tools.
- The DAG panel no longer mixes up state between overlapping runs.
- Run-level limits: 5M tokens, 30 minutes, 8 parallel nodes, 128 nodes and node `maxTurns`
  capped by its profile.
- `lifecycle.log` redacts credentials, caps line length and rotates at 1 MiB.
- DAG IPC payloads (run status, run list and events) are bounded to 64 KiB per string.


## [1.0.3] - 2026-08-05

### Added

- 

### Changed

- 

### Fixed

- 


## [1.0.2] - 2026-08-05

Continues the 1.0.x line started by the `V1.0.1` tag. The `0.7.0` and `0.7.1` sections below
describe work that was developed on a branch that had forked before the wave-1 coverage work; it
never shipped as a release of its own and is included here. Everything in `V1.0.1` is also
included — the two lines were rebased together, not chosen between.

### Fixed

- **`package.json` now matches the tag.** `V1.0.1` shipped with `"version": "0.6.0"`, so the app
  reported 0.6.0 and `electron-updater` compared against 0.6.0 — auto-update from that build could
  not resolve correctly. `scripts/release.mjs` exists to stop this recurring
- **NanoGPT subscription usage.** `V1.0.1` did not fix this despite conforming other NanoGPT
  surfaces to the published API: `fetchSubscriptionUsage` still parsed `daily` and `monthly`
  buckets, which the endpoint does not return, and threw on every call. The real buckets are
  `dailyInputTokens`, `weeklyInputTokens` and `dailyImages`
- `StatusBar`'s NanoGPT dot read the removed `daily`/`monthly` percentages. It now takes the worst
  percentage across the buckets actually reported; an unknown bucket counts as neither headroom nor
  exhaustion

## [0.7.1] - 2026-08-05

### Added

- Crash log readout in Settings — `crashlog.ts` wrote `crash.log` but nothing read it back. Two new
  channels, `oc:crashlog:read` (bounded 64 KiB tail plus metadata, never the whole file, never
  throws on a missing log) and `oc:crashlog:reveal` (main builds the path itself)
- `CHANGELOG.md` and `scripts/release.mjs` (`npm run release`) — one step bumps, builds, commits and
  tags, so the 0.6.0-in-git / 0.7.0-in-dist drift cannot recur
- CI packaging job — `dist:win:dir` runs on windows-latest for every pull request, catching
  electron-builder breakage at PR time instead of release time
- CI supply-chain gate — `npm audit --audit-level=high` fails the build on a new high or critical
  advisory
- `docs/RELEASE_VERIFICATION.md`, the manual runbook for an updater round-trip

### Changed

- `@opencode-ai/sdk` 1.18.4 → 1.18.13 (the core dependency, nine patches behind), plus electron
  43.3.0, `@google/genai` 2.15.0, and the `@typescript-eslint` 8.66 set

### Fixed

- **Three high-severity advisories cleared** — `brace-expansion` (DoS via unbounded expansion),
  `fast-uri` (host confusion via backslash authority introducer) and `undici` (downstream response
  desynchronization, plus four related advisories)
- **NanoGPT subscription usage no longer errors.** The client parsed `daily` and `monthly` buckets
  the API does not return; the real ones are `dailyInputTokens`, `weeklyInputTokens` and
  `dailyImages`, with the period boundary at `period.currentPeriodEnd`. Buckets now degrade rather
  than throw when fields are absent, "no cap" is kept distinct from "unknown", and the panel no
  longer overflows horizontally
- **A failed global shortcut no longer kills Quick Entry.** The error names concrete alternatives,
  the last successfully registered accelerator is restored when a new one fails, and Apply retries
  registration so recovery needs no restart

### Known issues

- Windows builds are **not code-signed** — SmartScreen will warn on first run. Tracked as ROADMAP
  M1.1
- One moderate advisory remains: `dompurify` via `monaco-editor`. The only fix npm offers is a
  downgrade of monaco from 0.56.0 to 0.53.0; no monaco release at or above 0.56.0 resolves it


## [0.7.0] - 2026-08-04

### Added

- Sidebar subagent section and promptable subagent tabs (PR #4)
- `ROADMAP.md` — nine-module plan derived from a fresh audit of the main process, renderer, and test/CI/release surface

### Fixed

- Windows installer and portable exe rebuilt against current `main` — the previous `dist/` artifacts were labelled 0.7.0 but built from an uncommitted version bump
- Two stale claims corrected in `PRODUCTION_PLAN.md` and `CONTINUATION.md` (the p2/p3 branches are merged; npm audit is 6 findings, not 21)
