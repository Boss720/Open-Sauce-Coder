# AGENTS.md — OpenCode Desktop

Guidance for AI coding agents working in this repository. Read this before making changes;
verify anything load-bearing against the working tree rather than trusting this file blindly.

## Project overview

**OpenCode Desktop** is a Claude-Code-style desktop GUI for coding agents, built with
Electron 43 + React 19 + TypeScript. The engine underneath is the **OpenCode CLI**
(`opencode serve` child process), which means any model provider OpenCode supports
(Groq, Gemini, OpenRouter, Ollama, …) — there is no Anthropic dependency anywhere.

Runtime architecture (binding — do not restructure):

```
renderer (React)  <--IPC-->  main (Electron)  <--HTTP/SSE-->  `opencode serve` child process
```

- **Main process owns everything stateful.** It spawns and supervises `opencode serve`
  (bound to `127.0.0.1`, starting at port **4599**), holds the only `@opencode-ai/sdk`
  client, and subscribes exactly once to the server's SSE event stream.
- **The renderer never speaks HTTP** and never imports SDK runtime code — only
  `import type { ... } from '@opencode-ai/sdk'`. All traffic goes through the
  `contextBridge` API (`window.api`) defined in `src/preload/`.
- **Events are rebroadcast verbatim.** Every SSE event main receives is forwarded on the
  `oc:event` channel; a single reducer (`applyEvent` in the renderer's `eventSlice`)
  folds them into zustand UI state.
- The child server is killed on quit (process-tree kill via `taskkill /T /F` on Windows).

**`CONTRACTS.md` is the binding interface spec** — IPC channel names, the `window.api`
shape, SDK call signatures, SSE event types, BYOK rules. Channel names are fixed there;
do not invent alternatives. When changing the IPC surface, update CONTRACTS.md too.

## Repository layout

```
src/
  main/                 Electron main process (Node). One module per concern:
    index.ts            app lifecycle, window creation, server supervision, event fan-out
    server.ts           owns the opencode child process + the single SDK client + SSE subscription
    ipc.ts              every renderer->main invoke channel; delegates to service modules
    fsService.ts        filesystem read/write with path containment + write concurrency (baseSha)
    gitService.ts       git via execFile argv arrays (read/commit only — never push/force)
    terminal.ts         node-pty management, pinned cwd, allowlisted env, per-WebContents keying
    keys.ts             BYOK storage — the ONLY module touching Electron safeStorage
    env.ts              child-env allowlist (ALLOWLIST/ALIASES) for opencode + PTY processes
    mcp.ts              MCP connector management
    projects.ts, projectsPaths.ts   project registry; assertSubpath() containment helper
    appSettings.ts, updater.ts, menu.ts, tray.ts, quickEntry.ts, crashlog.ts, openEditor.ts
    providerCatalog.ts, nanogpt*.ts, geminiLive.ts, geminiLiveConfig.ts, liveTranscripts.ts   provider integrations
    harness/            agentic harness — single-agent LLM runs with tool calling (alongside
                        opencode serve, which stays the primary chat path):
      profiles.ts       AgentProfile type, validation, BUILTIN_PROFILES
      profileStore.ts   custom-profile persistence to userData/harness-profiles.json
      providers/        ProviderAdapter + registry (nanogpt, gemini; openai-compat/anthropic/
                        opencode-bridge deferred)
      tools/            ToolRegistry + built-in executors (assertSubpath-contained)
      runner.ts         AgentRunner — conversation/tool loop; budget hard stops in code
      controller.ts     HarnessController — profile CRUD + run lifecycle behind oc:harness:*
                        (multi-agent DAG orchestrator deferred)
    __tests__/          vitest unit tests for main modules
  preload/
    index.ts            contextBridge definition of window.api (the ONLY bridge)
    index.d.ts          renderer-visible typings for window.api
  renderer/
    index.html          CSP meta tag lives here (see Security)
    src/
      main.tsx, App.tsx React entry + shell
      components/       one .tsx per panel (Chat, Composer, ToolCall, Sidebar, GitPanel,
                        TerminalPanel, EditorPanel, ChangesPanel, HarnessPanel, ...)
                        + per-feature .css files
      lib/
        store.ts        zustand store — COMPOSITION ROOT ONLY; state lives in slices/
        slices/         domain slices: session, routing, compare, subagent, agent, projects, ui,
                        event, editor, fileTree, git, terminal, images, attemptMachine, harness
        types.ts        shared renderer types
        *.ts            pure helper modules (format, routing, rotation, hunks, artifacts, ...)
        __tests__/      vitest unit tests for helpers and slices
electron.vite.config.ts build config for all three targets (main / preload / renderer)
electron-builder.yml    packaging config (Windows NSIS + portable, x64)
vitest.config.ts        test config — node environment, two __tests__ roots
tsconfig.node.json      main + preload + electron.vite.config.ts
tsconfig.web.json       renderer (with @renderer/* path alias)
eslint.config.js        flat ESLint config
CONTRACTS.md            binding IPC/SDK/security contract — read before touching IPC
docs/history/CONTINUATION.md, docs/history/HANDOFF_GEMINI.md, docs/history/PRODUCTION_PLAN.md   historical agent handoffs
```

Generated/packaged output (`out/`, `dist/`, `dist-*/`, `release/`) is gitignored — never
edit or commit it.

## Build and test commands

Prerequisites: **Node.js 20.19+ or 22.12+** (electron-vite 5 requirement) and the OpenCode
CLI on PATH (`npm i -g opencode-ai`; the app spawns `opencode.cmd` on Windows).

```powershell
npm install          # first time only
npm run dev          # electron-vite dev — Vite HMR for renderer, hot restart for main
npm run typecheck    # tsc over BOTH projects (node + web); must be clean before a PR
npm run lint         # ESLint; 0 errors required
npm run test         # vitest run (~554 test blocks across src/main and src/renderer/src/lib)
npm run build        # production bundle into out/
npm run dist:win     # build + package Windows installers into dist/
```

- Run `npm run typecheck`, `npm run lint`, and `npm run test` after any code change —
  all three are the CI gate (`.github/workflows/ci.yml`, on ubuntu-latest AND
  windows-latest, Node 22, `npm ci`).
- Windows is the primary target: the app spawns `opencode.cmd`, reaps children with
  `taskkill`, and encrypts keys via DPAPI (`safeStorage`). Keep Windows behavior
  first-class when changing process/env/storage code.
- electron-builder publishes to GitHub (`Boss720/Open-Sauce-Coder`); `electron-updater` in the
  main process consumes that feed for auto-updates.

## Code style guidelines

- **TypeScript strict everywhere**, ESM (`"type": "module"`), no semicolons, single
  quotes, 2-space indent — match the existing files.
- The one big exception: the **preload bundle must emit CommonJS** (sandboxed renderers
  reject ESM preloads). This is configured in `electron.vite.config.ts` — do not change it.
- `@opencode-ai/sdk` and Node built-ins are externalized from main/preload bundles and
  must never be bundled (see the comments in `electron.vite.config.ts`).
- Renderer styling: **plain CSS with custom properties** (design tokens `--bg`, `--accent`,
  `--mono`, … defined in `src/renderer/src/index.css`), BEM-ish class names, one
  stylesheet per feature area under `components/`. No Tailwind, no CSS-in-JS. Visual
  language: warm charcoal dark / warm ivory light theme, terracotta accent, serif display
  headings; no blue/green accents. Full token list and palette are in CONTRACTS.md
  ("Styling" section) — the contract token names must not be removed.
- Components read server state via zustand selectors only — no local copies of server
  state. New state belongs in a domain slice under `lib/slices/`, not in `store.ts`.
- Pure helpers stay pure (no store, no React, no IPC) so they remain unit-testable.
- Lint baseline: 0 errors; ~40 pre-existing `@typescript-eslint/no-explicit-any`
  warnings are the baseline, not a regression — don't add new ones.

## Testing instructions

- Framework: **vitest** (node environment, `globals: false` — import `describe`/`it`/`expect`
  explicitly). Config: `vitest.config.ts`; test roots are `src/main/__tests__/**/*.test.ts`
  and `src/renderer/src/lib/__tests__/**/*.test.ts`.
- Tests are pure unit tests: main-process services are tested with mocked fs/child_process/
  electron seams; renderer slices and helpers are tested directly. There is no component
  or E2E test harness — don't add heavy infrastructure without discussion.
- New behavior in a main service or a `lib/` module should come with a test in the
  matching `__tests__` directory. Tests must pass on Windows and Linux (CI runs both).

## Security considerations (binding, not advisory)

1. **Keys never live in this repo.** There is no `.env` to commit and no key field that
   persists plaintext. `opencode.json` (local provider config) and `auth.json` are
   gitignored.
2. **BYOK storage** (`src/main/keys.ts`) is the only module that touches `safeStorage`.
   Keys are encrypted at rest (DPAPI/Keychain/libsecret), injected into the opencode
   child env at spawn — never written to `auth.json`, never logged, never returned across
   IPC unmasked. Write fails closed when encryption is unavailable.
3. **Path containment.** Every path from the renderer is validated with `assertSubpath`
   from `src/main/projectsPaths.ts`. Reuse it — never write a second containment check.
4. **No shell interpolation for git.** All git invocations use argv arrays via `execFile`;
   no push, no `--force`, no `reset --hard` are exposed at all.
5. **PTY confinement.** Terminals are pinned to the session directory and get the
   allowlisted env from `src/main/env.ts` — a PTY must not inherit decrypted BYOK keys.
6. **Deep links are scheme-allowlisted** (`vscode://`, `vscode-insiders://`, `cursor://`
   only); main builds the URL from a contained path, the renderer never passes a URL.
7. **Output bounds:** file reads cap at 2 MiB, diffs at 5 000 lines per file, PTY output
   is chunked/back-pressured.
8. **Renderer hardening:** `contextIsolation: true`, `nodeIntegration: false`, and a CSP
   in `src/renderer/index.html`. The dev CSP whitelists loopback only; the production
   build swaps in a locked-down CSP via the `prod-csp` plugin in
   `electron.vite.config.ts` — no `'unsafe-eval'`, no remote origins. Don't loosen either.
9. **Writes are concurrency-gated:** `oc:fs:write` requires `baseSha`; agent edits flow
   through OpenCode's own tools and are unaffected.
