# NanoGPT Agentic Harness Planning Progress

## Objective

Produce an evidence-based, implementation-ready multi-module plan for evolving OpenCode Desktop into a Claude Code Desktop-style agentic coding harness for NanoGPT subscribers, while preserving the repository's renderer/IPC/main/OpenCode runtime contract.

## Repository baseline

- Repository: `C:\Users\Hp\Dev\opencode-desktop`
- Branch: `harness`
- Mode: implementation and verification; existing product changes are being preserved
- Existing worktree changes: Leroy/live-screen work is already in progress and must remain untouched

## Swarm lanes

| Lane | Owner | Read scope | Deliverable | Status |
| --- | --- | --- | --- | --- |
| Harness architecture | architecture worker | `src/main/harness/**`, `src/main/server.ts`, `src/main/ipc.ts`, `src/preload/**`, harness tests, `CONTRACTS.md` | Current-state/gap map and staged runtime architecture | Blocked by agent usage limit; independently audited by root |
| NanoGPT provider and security | provider worker | `src/main/nanogpt*.ts`, `src/main/providerCatalog.ts`, `src/main/keys.ts`, `src/main/env.ts`, harness providers/tools, related tests and contract sections | Provider, auth, tool-calling, usage, error, and security plan | Completed; report reconciled into plan |
| Desktop UX, testing, and release | product worker | renderer harness/chat/project/editor/terminal/git surfaces and slices, packaging/CI/test config, related tests | Claude Code-style user journeys, reachability, release and validation plan | Blocked by agent usage limit; independently audited by root |
| Coordinator reconciliation | root | repository-wide read-only verification and plan document | Unified dependency-ordered roadmap | Completed |

## Verification policy

- Worker reports are evidence leads, not accepted proof.
- Coordinator will verify cited paths and symbols in the working tree.
- No lane may edit files, tests, lockfiles, generated output, or shared documentation.
- Final plan must separate implemented, partial, deferred, and absent capability.
- 2026-08-27: Narrowed in-app BYOK catalog, provider panel, child-process env allowlist, and setup copy to NanoGPT plus Gemini/Gemini Live; unsupported providers remain outside the BYOK surface.
- 2026-08-27: Focused BYOK tests (85) and full suite (1,725) passed; lint passed with 0 errors (existing warnings remain).

## Wave log

- 2026-08-27: Baseline recorded; three read-only audit lanes prepared for dispatch.
- 2026-08-27: Provider/security lane completed. Architecture and UX/release workers exhausted the account usage limit; root independently verified their scopes.
- 2026-08-27: Wrote `docs/plans/nanogpt-agentic-harness/PLAN.md` with M0–M9 modules, dependency graph, acceptance criteria, security contracts, NanoGPT verification notes, and release gates.
- 2026-08-27: `cmd.exe /c npm run typecheck` passed (node and web projects).

## Open decisions

- Exact NanoGPT API behavior and subscriber entitlement contract must be verified from authoritative/current documentation before implementation.
- Decide whether NanoGPT becomes the default first-party harness adapter or an opt-in provider alongside the existing OpenCode primary chat path.

## Next step

Plan delivered at `docs/plans/nanogpt-agentic-harness/PLAN.md`. The current implementation wave is the NanoGPT/Gemini BYOK restriction; next product work should resolve the five plan decisions and run live, redacted NanoGPT contract probes.

## 2026-10-05 Full product assessment

- Target: `D:\AI\projects\Dev\opencode-desktop`, branch `harness`; assess current working tree including ongoing changes. Preserve existing code and plans.
- User brief: multi-provider daily-use agent workspace; broad harness; explainable balanced quality/cost/speed routing; configurable subagents with automatic recommendations; per-project autonomy defaults; sleek, intuitive dark UI.
- Requested providers: Gemini, Groq, Mistral, OpenRouter, Moonshot, xAI, NanoGPT, and presumed Cerebras (user wrote cerberus), plus existing integrations.
- Deliverables: evidence-linked assessment, prioritized fixes/features/QoL roadmap, and three interactive dark-theme concept mockups. Production implementation is outside this assessment.
- Read-only review lanes: runtime/provider/security (worker), routing/subagents/project autonomy (worker), UI/release/reachability (worker). Coordinator owns this progress entry, final report, independent verification, and mockups.
- Verification: run typecheck, lint, full tests, contract check, production build; independently inspect cited code. Distinguish source reachability, mocked tests, and live application/provider proof.
- Wave status: three read-only reviews completed and independently reconciled; no worker file edits. Existing product changes preserved.
- Assessment delivered: `docs/assessment-2026-10-05/ASSESSMENT.md`; six inert source reproductions in `probes.mjs`/`probes.log`; verification logs saved beside the report.
- Fresh gates: typecheck passed; lint 0 errors/100 existing warnings; 98 test files and 1,725 tests passed; coverage passed (71.25% statements, 65.62% branches, 73.17% functions, 73.96% lines); production build passed.
- Open failures: contract checker reports five Leroy method documentation mismatches and an event registration warning; npm audit reports 13 vulnerabilities (8 high, 5 moderate). No dependency or product-code fixes applied.
- Confirmed high-impact issues: harness execution bypasses advertised policy; Stop uses wrong request ID and allows late tools; empty tools widen to all; runner reports truncated output complete. Source findings include failover policy loss and cleared side-effect guards, plus lossy profile editing.
- Three interactive concepts: Copper Focus, Obsidian Studio, Plum Collective. Headless installed Edge confirmed 320/360/736/1024px fit, sample routing/composer/project-policy interactions, and no JS page errors; screenshots visually inspected. These are proposed designs, not live application screenshots.
- Evidence limits: no real provider inference/billing, packaged executable launch/focus, updater, voice, or device testing. Node unit/coverage success does not validate omitted UI/runtime integration paths.
- Recommended next step: freeze a bounded M0 correctness spec, resolve policy/cancellation/retry/profile and release-gate failures, then implement the shared multi-provider foundation. Keep the prior NanoGPT plan and Leroy work; reconcile their narrower provider boundary with the new brief.
- User selected Copper Focus in the mockup picker; the assessment now records it as the default UI direction and carries it into M5, with Studio and Collective as shared-context review/setup modes.

## 2026-10-05 Copper Focus task workspace UI

- Added a global workspace header with the current project name, plus a task-centered sidebar for Tasks, Agents, Providers, tools, recent tasks, project settings, and folder switching.
- Added a live task heading and a Review changes action wired to the existing Changes panel.
- Added an expandable task context/team area populated from the active session, workspace, branch, route, read-only state, configured agents, and child runs.
- Kept provider setup, live screen, images, project settings, session search, and subagent navigation reachable through the revised layout; added compact-width styling.
- Verification: `npm run typecheck` passed; targeted renderer ESLint passed; `npm run lint` passed with 0 errors/116 warnings; `npm run test` passed (103 files, 1,788 tests); `npm run build` passed.
- `git diff --check` still reports the existing extra blank line at the end of `src/renderer/src/index.css`. No live-window smoke test was confirmed: existing Electron/OpenCode processes had no visible window handles, so they were left running and no duplicate instance was started.

## 2026-10-05 Windows executable and installer refresh

- Rebuilt the current source as Windows x64 with Electron 43.3.0, keeping package version 1.0.3. Publishing was explicitly disabled.
- Updated `dist/OpenCode-Desktop-1.0.3-portable.exe` (130,664,394 bytes; SHA-256 `097571C71F9843E405DCEA09D59198A7B673ADF157CA3689C7BC718CAB3DDC1A`) and `dist/OpenCode-Desktop-1.0.3-setup.exe` (130,890,499 bytes; SHA-256 `3ECF8AAD06BC6E8F9D792CBEF74429F5D9A10B630202BF04A5AA73FCB8276BD4`). Regenerated the setup blockmap and `dist/latest.yml`; the metadata SHA-512 matches the installer.
- Verified the packaged ASAR contains Copper Focus UI labels. Launched the portable EXE; its Electron process created an `OpenCode Desktop` window.
- Verification: `npm run typecheck`, `npm run lint` (0 errors/116 warnings), `npm run build`, and `npx electron-builder --win --x64 --publish never` succeeded. The portable and setup executables are unsigned; no certificate was configured, so Windows may show an unknown-publisher/SmartScreen prompt. The installer was built but not run.
- These local artifacts replace version 1.0.3 outputs; they were not published. An already-installed 1.0.3 will not receive a same-version automatic update.

## 2026-10-05 Copper Focus UI and QOL follow-up

- Applied the selected Copper Focus palette to dark-by-default tokens (warm charcoal, peach-copper accent, warmer readable foreground); tightened chat spacing for compact windows and added a soft copper cue to the active workspace tab.
- Harness run monitor now follows live output only while the user is near the bottom. Scrolling back preserves reading position and reveals an accessible “Jump to latest” button.
- Reconciled the assessment against the current in-progress source. Existing policy work already blocks profile-excluded/read-only tools before dispatch, maps Stop to the active request, skips late tool calls, and preserves `tools: []`; corrected `docs/assessment-2026-10-05/probes.mjs` and refreshed `probes.log` to verify these states.
- Remaining reproduced harness issues: token budgets only gate input usage before requests, cost budget enforcement is absent, and provider output truncation (`finishReason: length`) is surfaced as success. These remain assessment findings for the next correctness pass.
- Verification: `npm run typecheck` passed; `npm run lint` passed with 0 errors/116 warnings; `npm run test` passed (103 files, 1,788 tests); `npm run build` passed; `npm run check:contracts` passed; `npm audit --audit-level=high` found 0 vulnerabilities.
- `git diff --check` still reports pre-existing blank lines at EOF in dirty files (composer.css, index.css, eventSlice.test.ts, and two subagent tests). No attempt made to normalize unrelated user changes. The new CSS is compiled by the production build; no packaged/live Electron-window smoke test was run.
- Assessment follow-up has been added to `docs/assessment-2026-10-05/ASSESSMENT.md`. Existing branch changes remain uncommitted and preserved.

## 2026-10-05 Free model router and Google quota integration

- Objective: assess the existing free-model router against the supplied Google AI Studio rate-limit screenshots; incorporate the most relevant currently callable models and make routing/quota handling safer and more explainable.
- Repository: `D:\AI\projects\Dev\opencode-desktop`, branch `harness`. The existing dirty UI/harness/provider work is user-owned and must be preserved.
- Scope: read-only parallel audits of renderer router/caps, official Google model/rate-limit evidence, and provider catalog/authorization boundaries; coordinator owns implementation, tests, integration review, and final gates. No worker file edits.
- Acceptance: only expose verified model IDs/capabilities; respect conservative quota ceilings without treating account usage as universal; keep automatic routing authenticated and free/subscription eligible; accurately classify transient vs daily quota blocks; show usable candidate health/reasons; add focused regressions; run typecheck, lint, tests, contracts, and build.
- Verification limitations: screenshots show one account's observed limits; no live key/inference or billing verification is implied by catalog inclusion.
- Wave status: implementation complete; verification gates passed. Existing dirty repository work preserved.
- Read-only wave complete. Router reviewer reported 137/137 scoped existing tests passing plus probes for missing cases; provider reviewer confirmed exact model/auth boundaries; documentation review confirmed official text/function-call support and rate-limit semantics. Root independently confirmed official API IDs and Gemma hosted function declarations against Google primary docs on 2026-10-05. No worker edits.
- Findings accepted for implementation: add exact, ranked Gemini Flash 3.8/3.7 and Gemini 3 Flash Preview IDs; activate Gemma 4 31B/26B only with exact hosted IDs and live agent-capability checks; add exact model cap scopes; classify exhausted dimensions correctly; retain sends over 25-hour Pacific fallback day; correct burst/zero-cap recovery; make routing health reflect live eligible models and TPM. Preserve static auth boundary and clearly label desktop-observed quota accounting.
- Implementation: exact Google Flash/Flash-Lite/Preview and hosted Gemma IDs are ranked and scoped to the supplied snapshot; Google TPM uses input-token events; quota errors distinguish explicit daily limits, generic rate exhaustion, and oversized TPM requests; rolling send history covers 48 hours; recovery times include burst windows, exact expiry boundaries, and permanent zero caps. Routing health now enumerates live linked text-and-tool models, explains local RPM/RPD/TPM/burst usage and scope, and caps the display at 60 rows. Existing exact catalog/auth and agent-capability gates remain in place; no provider IPC changes.
- Verification: `npm run typecheck` passed; `npm run lint -- --quiet` passed with no lint errors; `npm run test` passed (103 files, 1,802 tests); `npm run check:contracts` passed; `npm run build` passed. The full `git diff --check` still flags existing trailing blank lines in `composer.css`, `index.css`, `eventSlice.test.ts`, and two subagent tests; scoped router files are clean.
- Next: no required implementation remains. Live provider quota/inference and usage by other apps are not observable from the local ledger.

## Handoff — free-model router integration (2026-10-05)

- Status: implementation and required gates complete.
- Root: `D:\AI\projects\Dev\opencode-desktop`, branch `harness`. Preserve all existing dirty UI, harness, provider, Leroy, and assessment work.
- User request: use the supplied Google AI Studio rate-limit screenshots to assess and improve the existing free-model router, add the most relevant verified models, and make necessary quota/routing adjustments.
- Verified Google API IDs/capabilities from primary docs: Gemini 3.8/3.7/3.6/3.5 Flash; 3.5 and 3.1 Flash-Lite; Gemini 3 Flash Preview; Gemini 2.5 Flash/Flash-Lite; Gemma 4 `gemma-4-31b-it` and `gemma-4-26b-a4b-it`. Gemini text models support function calling; Gemma hosted API docs show tool declarations. Runtime must still gate by the exact live OpenCode model catalog and `toolcall` + text input/output capabilities. No authorization or IPC changes are needed.
- Screenshots show account-specific model limits: Flash 5 RPM / 250K input TPM / 20 RPD; 3.1/3.5 Flash-Lite 15 / 250K / 500; 2.5 Flash-Lite 10 / 250K / 20; Gemma 4 30 / 16K / 14,400. Screenshot numerators are peak usage over 28 days, not current usage. Google limits are project-scoped and RPD resets midnight Pacific.
- Completed: `src/renderer/src/lib/freeTier.ts` and `routing.ts` now use verified Google IDs, model-specific screenshot denominators, input-only Google TPM, and DST-safe usage windows; `rotation.ts`, `attempts.ts`, and the session/event slices route generic minute, explicit daily, and oversized TPM errors differently; `RoutingPanel.tsx` shows dynamic eligible catalog entries with local usage and reset scope. Focused regressions cover IDs/caps, TPM, failover, DST retention, burst recovery, and zero caps.
- Verification: `npm run typecheck` passed; `npm run lint -- --quiet` passed with no lint errors; `npm run test` passed (103 files, 1,802 tests); `npm run check:contracts` passed; `npm run build` passed. `git diff --check` flags only the pre-existing unrelated trailing blank lines listed above.
- Reviews: read-only router lane reported 137 scoped existing tests pass and identified missing cases; provider lane found existing model authorization is exact-catalog-bound; official Google rate-limit docs say numbers vary by project/account. Worker findings are leads, not verification of this implementation.
- Known boundary: no real inference, account quota refresh, external-client usage accounting, or billing proof has been performed. The screenshot numerators are historical 28-day peak use, not current usage, and account limits can vary by project/tier. No live Electron window smoke test was run; the production bundle passed, and `RoutingPanel` is mounted in Settings under “Live Model Health.”
- Primary references checked: [Google model IDs and Gemini 3.8 Flash capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite), [Gemma on the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api), and [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## 2026-10-18 Lint warning cleanup

- Objective: remove all 163 ESLint warnings without weakening lint rules or changing intended behavior. Root C:\Users\Hp\Dev\opencode-desktop; branch harness; existing dirty/untracked work preserved.
- Wave 1 ownership: main-tests worker owns src/main/__tests__ warning files only; renderer-core-tests worker owns sessionSlice.test.ts, gitSlice.test.ts, eventSlice.test.ts; renderer-other-tests worker owns remaining renderer test warning files. Coordinator owns production warning files and PROGRESS.md.
- Model choice: gpt-6-luna for bounded test typing cleanup; coordinator handles production types and hook dependencies.
- Verification: scoped lint and typecheck per lane; coordinator reviews changes against captured pre-cleanup contents, then runs full typecheck, lint, tests, and production build. No new tests required for type/unused-symbol cleanup.
- Status: baseline captured (163 warnings, 0 errors); independent lanes ready for dispatch.
