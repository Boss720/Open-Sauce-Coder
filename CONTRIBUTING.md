# Contributing

Terse version of how work gets done in this repo. `AGENTS.md` is the deeper
reference; `CONTRACTS.md` is the binding interface spec. When they disagree
with this file, they win.

## Setup

- **Node.js 20.19+ or 22.12+** (electron-vite 5 requirement).
- **OpenCode CLI on PATH**: `npm i -g opencode-ai`. The app spawns
  `opencode.cmd` on Windows (`%APPDATA%\npm\opencode.cmd` first, then PATH).
- `npm install`
- `npm run dev` — electron-vite dev: Vite HMR for the renderer, hot restart
  for main. (For driving the real window, see below — a bare `npm run dev`
  against a stale instance lies to you.)

## Quality gate — all three required before a PR

```bash
npm run typecheck   # tsc over both projects (node + web); must be clean
npm run lint        # ESLint; 0 errors required
npm run test        # vitest run
```

CI (`.github/workflows/ci.yml`) runs exactly these on ubuntu-latest and
windows-latest, Node 22, `npm ci`. Lint baseline: 0 errors and ~40
pre-existing `@typescript-eslint/no-explicit-any` warnings — the warnings are
the baseline, don't add new ones. After a change that affects runtime
behavior, also smoke test the running app (below).

## Ground rules (binding)

1. **CONTRACTS.md first.** It is the single source of truth for IPC channel
   names, the `window.api` shape, SDK call signatures, and SSE event types.
   Update it before (or with) any change that adds surface. Do not invent
   channel names.
2. **Main owns HTTP.** The main process holds the only `@opencode-ai/sdk`
   client and the single SSE subscription. The renderer never speaks HTTP and
   imports SDK **types only**. All backend calls go through `window.api`;
   every SSE event is rebroadcast verbatim on `oc:event` and folded by the
   single `applyEvent` reducer. (See `docs/adr/0003-main-owns-http.md`.)
3. **State lives in slices.** New renderer state goes in a domain slice under
   `src/renderer/src/lib/slices/`, composed in `lib/store.ts` — `store.ts` is
   a composition root, not a junk drawer. Components read server state via
   selectors only; no local copies.
4. **CSS tokens only.** Styling is plain CSS with the custom properties
   defined in `src/renderer/src/index.css` (BEM-ish class names, one
   stylesheet per feature area). Never invent a token name without adding it
   there first. No Tailwind, no CSS-in-JS.
5. **`register(ipc)` pattern.** New main-process services copy the
   `register(ipc)` pattern of the existing modules wired in `src/main/ipc.ts`
   (`fsService`, `gitService`, `terminal`, …). Channel names come from
   CONTRACTS.md.
6. **Windows-first.** `.cmd` spawn via `cmd.exe` with verbatim args,
   `taskkill /T /F` process-tree kill, DPAPI via `safeStorage`. Keep POSIX
   compiling (CI runs it), but design and verify on Windows first.
   (See `docs/adr/0004-windows-first.md`.)
7. **Keys stay in `keys.ts`.** BYOK storage is `src/main/keys.ts` via Electron
   `safeStorage` — the only module that touches it. Keys are injected into the
   child env at spawn, never written to `auth.json`, never logged, never
   returned across IPC unmasked. (See `docs/adr/0001` and `docs/adr/0002`.)
8. **Security invariants are binding.** Path containment via `assertSubpath`
   (`src/main/projectsPaths.ts`) — reuse it, never write a second check. Git
   runs via `execFile` argv arrays, no shell interpolation, no push/force.
   PTYs are pinned to the session directory and never inherit BYOK keys.
   Renderer hardening (`contextIsolation`, no node integration, CSP) is not
   loosened.
9. **No `gh` CLI, no direct pushes to `main`.** `gh` is not installed on the
   maintainer's machine and pushes to `main` are blocked. Push a feature
   branch and open the PR in the browser at
   `https://github.com/Boss720/Open-Sauce-Coder/pull/new/<branch>`.

## Driving the app — use the skill, not bare `npm run dev`

A stale dev instance holds port 5173 **and** the Electron single-instance
lock, so a second `npm run dev` prints `starting electron app...`, exits
silently, and leaves the OLD window (old code) on screen looking like your
build. Always go through the committed driver:

```bash
powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start
```

`.claude/skills/run-opencode-desktop/SKILL.md` has the full command reference
(`shot`, `status`, `stop`, …) and the accumulated gotchas — read its Gotchas
section before driving the window. Notable: `starting electron app...` is not
the ready signal (wait for `[vite] connected` in the dev log), and the app
cannot be driven through a browser at all — `http://127.0.0.1:5173` has no
`window.api` and never leaves the boot screen. Windows only; there is no
headless path.

## Tests

- Framework: **vitest**, node environment, `globals: false` — import
  `describe` / `it` / `expect` explicitly. Config: `vitest.config.ts`.
- Test roots:
  - `src/main/__tests__/**/*.test.ts` — main services with mocked
    fs/child_process/electron seams.
  - `src/renderer/src/lib/__tests__/**/*.test.ts` — slices and pure helpers.
- Tests must pass on Windows and Linux (CI runs both). There is no component
  or E2E harness — keep new tests pure unit tests; new behavior in a main
  service or a `lib/` module should come with a test in the matching
  `__tests__` directory.

## Style

TypeScript strict, ESM (`"type": "module"`), no semicolons, single quotes,
2-space indent. The one exception: the preload bundle emits CommonJS
(sandboxed renderers reject ESM preloads) — configured in
`electron.vite.config.ts`, do not change it. `@opencode-ai/sdk` and Node
built-ins are externalized from main/preload bundles and must never be
bundled. Pure helpers in `lib/` stay pure (no store, no React, no IPC) so
they remain unit-testable.
