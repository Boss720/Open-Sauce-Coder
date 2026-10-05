# OpenCode Desktop product and code assessment

Assessment date: 2026-10-05. Repository: `D:\AI\projects\Dev\opencode-desktop`. Branch: `harness`. HEAD: `ebcbf67665461078f0f80b348859ff66ab348d92`, plus the existing dirty working tree.

## Verdict

The existing app is a useful foundation for your proposed daily coding workspace. Keep its Electron/React shell, renderer → IPC → main → OpenCode boundary, encrypted key storage, project containment, event reducer, and existing code-review surfaces. The biggest gaps are consistent execution policy, reliable cancellation, actual provider breadth, and coordination between the primary chat and the separate harness. Address those before increasing autonomous delegation.

The current automatic router optimizes availability and free/subscription eligibility with a small curated coding-quality bias. It is not yet a balanced quality/cost/speed optimizer. Child-session tabs provide real monitoring and follow-up capability; they are not a configurable team scheduler. The direct harness is a single-agent runner, not a complete multi-agent coding environment.

The assessment was first produced as a read-only review of the then-current source. Existing application changes were preserved. The implementation follow-up below records subsequent changes and re-validation; the initial findings and verification table remain the original assessment snapshot.

## Implementation follow-up (2026-10-05)

After the assessment, you asked to carry the selected Copper Focus direction into the app, improve quality of life, and check for errors. The current follow-up changes tune the default dark tokens toward the selected warm charcoal/copper palette, tighten chat spacing at compact widths, accent the active code-workspace tab, and let the harness monitor pause auto-follow while you inspect earlier output (with a “Jump to latest” control). Existing in-progress policy changes in this worktree preserve the explicit empty tool allowlist and check profile/project policy at dispatch; this follow-up did not rewrite those changes. Validation results are recorded in the root progress log when complete. The desktop UI itself was not launched for a visual smoke test, so the palette/layout edits are source-verified pending a packaged-window review.

The original inert probe claims for read-only dispatch, Stop, and `tools: []` were stale against the current in-progress source. The probe script initially failed under Node 24 because it evaluated CommonJS output without an injected `require`; that was corrected and rerun. Current probe results confirm that read-only writes are blocked, Stop cancels the active request and skips late tool calls, and explicit empty allowlists survive validation. Two runner issues remain reproduced: the token budget ignores output tokens/reservation (and costBudget is not enforced), and a provider `length` finish reason is reported as complete. The first-version audit/contract results below have also been superseded by this fresh follow-up run.

Fresh follow-up gates: `npm run typecheck` passed; `npm run lint` passed with 0 errors and 116 warnings; `npm run test` passed (103 files, 1,788 tests); `npm run build` passed; `npm run check:contracts` passed; `npm audit --audit-level=high` found 0 vulnerabilities. The known diff hygiene check still reports blank lines at EOF in five dirty files, including files already modified before this UI pass. Full lint warnings are not errors; only the edited TSX file was linted by ESLint (CSS is ignored by this ESLint config). No packaged or live Electron window smoke test was run.

## Your product brief

- A sleek, intuitive, friendly daily replacement for GUI coding-agent apps.
- Multiple providers: Gemini, Groq, Mistral, OpenRouter, Moonshot, xAI, NanoGPT, presumed Cerebras (you wrote “cerberus”), and existing integrations.
- A broad harness with configurable subagents and automatic recommendations.
- Balanced quality, cost, and speed routing with a visible explanation.
- Per-project autonomy with sensible approval defaults.
- Several dark UI directions to compare.

## Fresh verification

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | Passed for node and web | [typecheck.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/typecheck.log) |
| `npm run lint` | Passed: 0 errors, 100 warnings | [lint.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/lint.log) |
| `npm run test` | 98 files and 1,725 tests passed | [tests.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/tests.log) |
| `npm run test:coverage` | Passed configured thresholds: statements 71.25%, branches 65.62%, functions 73.17%, lines 73.96% | [coverage.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/coverage.log) |
| `npm run check:contracts` | Failed: five Leroy API methods missing from the checker’s documentation match; event registration warning | [contracts.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/contracts.log) |
| `npm run build` | Passed | [build.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/build.log) |
| `npm audit --audit-level=high` | Failed: 13 dependency vulnerabilities, 8 high and 5 moderate | [audit.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/audit.log) |
| Inert source reproductions | Six findings confirmed without provider calls or side effects | [probes.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/probes.log), [repro script](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/probes.mjs) |
| Mockup browser checks | Three designs fit 320, 360, 736, and 1,024px; sample controls work; no JS page errors | [mockups.log](D:/AI/projects/Dev/opencode-desktop/docs/assessment-2026-10-05/mockups.log) |

Tests/build initially could not spawn esbuild inside the sandbox; rerunning with execution permission succeeded. This is an environment restriction, not a code defect. The documented lint baseline of roughly 40 warnings is outdated relative to the measured 100; these warnings were present before assessment probes were added.

Dependency audit entries span runtime, tooling, and packaged Electron dependencies. These counts are not proof that every advisory is exploitable in this app. Triage Electron, Undici, and the Monaco/DOMPurify chain first, classify exposure, then update compatible dependency ranges and rerun packaging checks. Do not use a blind force upgrade.

No real provider inference, billing, installed executable, visible Electron window, updater round trip, microphone, or physical-device behavior was tested. Mockup browser proof applies only to the concepts. UI findings below are source-derived unless explicitly identified as a reproduction. Passing unit tests and coverage do not establish correct real-provider or UI behavior.

## Current capability map

| Area | Working foundation | Partial or missing for your goal |
| --- | --- | --- |
| Runtime | Main-owned server/SDK/SSE, typed preload bridge, hardened renderer | Two execution paths with inconsistent permissions, lifecycle, and accounting |
| Provider setup | Encrypted NanoGPT and Google keys; model authorization | Current dirty catalog deliberately restricts desktop linkage to those two providers |
| Chat | Sessions, streaming OpenCode events, tools, approvals, retries, compare, child tabs | Unified task/run identity, durable session-level agent settings, fully safe retries |
| Direct harness | Global profiles, two adapters, single-agent tool loop, custom project tools | Streaming, durable runs/recovery, approval broker, spend enforcement, fallback/concurrency controls |
| Routing | Availability/cooldowns, account and model quotas, health ledger, deterministic selection | Task-aware quality evidence, paid budgets, transparent candidate explanations, per-child accounting |
| Subagents | OpenCode agent picker and Task-child monitoring/follow-up | Role editor, independent model/effort/scope/policy, recommendations, worktree scheduler |
| Project autonomy | OpenCode project permission presets | Shared enforcement across direct harness, retries, child sessions, and custom tools |
| Code workspace | Files, Monaco editor, changes, git, terminal, artifacts | Responsive layout, right-panel resizing, reliable cross-view navigation |
| Live/media | Gemini Live, image tools, opt-in Leroy sidecar | External setup/runtime proof; not essential to the first coding-workspace milestone |
| Tests/release | Extensive unit suite, Windows/Linux CI, coverage and packaging job | UI/lifecycle integration coverage, current contract/audit failures, packaged launch proof |

## Fixes to prioritize

P1 means high-impact correctness/security or a blocker for the stated product; P2 means important functional reliability or usability; P3 means polish. Confidence distinguishes a terminal reproduction from a source finding.

### P1: enforce policy before execution

**A read-only harness can execute an excluded tool. Confirmed with an inert executor.** [runner.ts:102](D:/AI/projects/Dev/opencode-desktop/src/main/harness/runner.ts:102) filters advertised tool schemas, but [runner.ts:188](D:/AI/projects/Dev/opencode-desktop/src/main/harness/runner.ts:188) sends returned names to [registry.ts:80](D:/AI/projects/Dev/opencode-desktop/src/main/harness/tools/registry.ts:80), which only checks registration. A model need not obey the advertised list. Enforce the effective allowlist/deny list/read-only policy at each tool dispatch, validate arguments, and fail closed before executor invocation. Regression: a fake provider requests an excluded write/shell/custom tool and the executor counter must remain zero.

**Project approval presets do not govern the direct harness. High confidence from source.** [controller.ts:95](D:/AI/projects/Dev/opencode-desktop/src/main/harness/controller.ts:95) starts an independent runner; builtin writes and shell commands execute directly at [builtins.ts:134](D:/AI/projects/Dev/opencode-desktop/src/main/harness/tools/builtins.ts:134) and line 209. OpenCode `edit: deny` or `bash: ask` therefore does not supply a harness approval boundary. Create a main-owned policy broker shared across executors. A pinned cwd is a working directory, not an OS filesystem sandbox.

**Harness subprocesses inherit the desktop environment. High confidence from source.** Builtin shell at [builtins.ts:209](D:/AI/projects/Dev/opencode-desktop/src/main/harness/tools/builtins.ts:209) and custom tools at [custom.ts:136](D:/AI/projects/Dev/opencode-desktop/src/main/harness/tools/custom.ts:136) omit explicit `env`. Reuse the explicit credential-free construction used by [terminal.ts:232](D:/AI/projects/Dev/opencode-desktop/src/main/terminal.ts:232). Main normally does not place decrypted BYOK secrets in process.env; the issue is unrelated credentials inherited from the launch environment.

### P1: make Stop truthful and effective

**Stop cancels the wrong request ID and late tool calls still execute. Confirmed.** [runner.ts:78](D:/AI/projects/Dev/opencode-desktop/src/main/harness/runner.ts:78) aborts the run ID while line 129 sends `runId-turn-N`; the adapters index active requests by that latter ID. Gemini also creates an abort controller but omits its signal from [generateContent at line 215](D:/AI/projects/Dev/opencode-desktop/src/main/harness/providers/gemini.ts:215). Add active-request tracking and transport cancellation, check cancellation immediately after provider return and before every tool, and own subprocess trees. Shell currently has no timeout/abort signal; custom-tool timeout alone does not cancel children on Stop. Regression: release a fake tool response after Stop; no tool runs and the final status stays cancelled.

### P1: preserve policy through retry and delegation

**Automatic failover drops agent and read-only tool settings. High confidence from source.** Normal send includes `harnessPromptFields` at [sessionSlice.ts:594](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/sessionSlice.ts:594); [attemptMachine.ts:323](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/attemptMachine.ts:323) retries without those fields. Carry an immutable effective policy/agent snapshot through every resend and child prompt. Child follow-ups at [subagentSlice.ts:166](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/subagentSlice.ts:166) and side chats at line 218 similarly omit those controls; actual server-default effects need an integration fixture.

**The send catch block clears its side-effect evidence before checking it. High confidence; trigger requires late IPC rejection after SSE progress.** [sessionSlice.ts:597](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/sessionSlice.ts:597) clears the active attempt; line 621 then reads it and regards null as safe. Capture the actual attempt before clearing it. The test at [sessionSlice.test.ts:976](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/__tests__/sessionSlice.test.ts:976) uses an inert clear mock and retains stale unsafe state, so it misses the production transition. Test real lifecycle interactions rather than mocked independence.

### P1: preserve configurable profiles

**Editing/cloning drops advanced fields; no tools can become all tools. Confirmed semantics, source-confirmed editor loss.** [HarnessPanel.tsx:52](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/components/HarnessPanel.tsx:52) and line 82 round-trip only a subset of AgentProfile. Fallbacks, thinking, topP, prompt files, deny lists, concurrency, cost budget, route suffix, billing route, and caching disappear on save. Line 102 serializes deselect-all as undefined. [profiles.ts:82](D:/AI/projects/Dev/opencode-desktop/src/main/harness/profiles.ts:82) also converts explicit `[]` to undefined, and registry treats undefined as unrestricted. Preserve unknown/advanced fields, make `[]` mean none, make `['*']` explicit, reject invalid safety limits, and regression-test a lossless save/clone.

### P1: restore provider breadth deliberately

**Your requested breadth conflicts with the current uncommitted restriction. Confirmed.** [providerCatalog.ts:17](D:/AI/projects/Dev/opencode-desktop/src/main/providerCatalog.ts:17), [env.ts:27](D:/AI/projects/Dev/opencode-desktop/src/main/env.ts:27), and provider authorization at [ipc.ts:430](D:/AI/projects/Dev/opencode-desktop/src/main/ipc.ts:430) currently admit only NanoGPT/Google-managed linkage. The dirty diff removes prior provider entries; this is coordinated with the current contract, not just a missing dropdown. Expand catalog, secure credentials, child environment, authorization, capabilities, adapter selection, and UI together. Keep discovered, configured, authenticated, inference-tested, and billing-verified states separate.

### P2: correct runner outcomes and resource controls

- **Truncated/error responses appear completed. Confirmed:** [runner.ts:164](D:/AI/projects/Dev/opencode-desktop/src/main/harness/runner.ts:164) maps non-tool outcomes to complete. Preserve `length`, malformed, blocked, and provider-error outcomes; offer safe continuation where appropriate.
- **Budget names overpromise. Confirmed:** tokenBudget only checks accumulated input before the next request, ignoring output/reasoning and next-request reservation. A budget of 2 allowed a completed fake response using 101 total tokens. costBudget is currently deferred/inert, not an implemented spend cap. Show measured usage versus estimated spend distinctly and implement conservative reservation plus post-response reconciliation.
- **Profile controls are partly inert:** fallbackModels, systemPromptFile, maxConcurrent are validated without execution support; a hidden 20-round cap wins over 40/50-turn profiles. Implement admission/fallback/file loading or label these unsupported. Evidence: [profiles.ts:16](D:/AI/projects/Dev/opencode-desktop/src/main/harness/profiles.ts:16), [runner.ts:35](D:/AI/projects/Dev/opencode-desktop/src/main/harness/runner.ts:35), [controller.ts:122](D:/AI/projects/Dev/opencode-desktop/src/main/harness/controller.ts:122).
- **Listing the project root fails:** fs_list('.') goes through strict file containment, which rejects root equality at [projectsPaths.ts:33](D:/AI/projects/Dev/opencode-desktop/src/main/projectsPaths.ts:33). Extend the shared helper with an explicitly allowed-root directory mode; retain symlink/junction safeguards. Do not create a second containment implementation.
- **Web tools read the whole body before slicing:** [builtins.ts:318](D:/AI/projects/Dev/opencode-desktop/src/main/harness/tools/builtins.ts:318) uses response.text then capWebOutput. Add stream byte caps, destination/redirect checks, and explicit network policy. Current HTTP(S)-only validation does not reject private-network/metadata targets.
- **Gemini history loses native metadata:** [gemini.ts:145](D:/AI/projects/Dev/opencode-desktop/src/main/harness/providers/gemini.ts:145) flattens native calls and line 98 rebuilds them; image parts and thought signatures are not preserved. Test repeated function names, multimodal histories, and multi-step calls against provider-specific fixtures. Google documents preserving thought signatures through relevant function-call histories: [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).

### P2: improve router correctness before sophistication

- When [selectModel](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/routing.ts:499) returns null, [sessionSlice.ts:530](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/sessionSlice.ts:530) falls through to the current model. Show no eligible route/next availability instead of bypassing the configured pool or health decision.
- [rotation.ts:72](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/rotation.ts:72) treats generic RESOURCE_EXHAUSTED as daily exhaustion. Preserve structured RPM/TPM/RPD evidence and Retry-After; do not park a model until tomorrow on generic quota wording.
- [RoutingPanel.tsx:33](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/components/RoutingPanel.tsx:33) lists only curated FREE_MODEL_TIERS; NanoGPT and newly discovered models are absent. Derive health rows from runnable/discovered models and observed attempts, with optional curated annotations.
- Child prompts share the parent’s current model and bypass the parent routing ledger. Give each run its own attempt state while sharing provider/account quota and spend accounting.

### P2/P3: desktop usability and reachability

- At the 780px minimum window width, the 520px maximum sidebar plus a minimum 22rem code panel can consume the center. Add a minimum task width, responsive sidebar rail, and panel overlay/stacking. Evidence: [App.tsx:51](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/App.tsx:51), [index.css:241](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/index.css:241), [index.ts:42](D:/AI/projects/Dev/opencode-desktop/src/main/index.ts:42).
- Palette/status actions select code panels while Projects/Images/Harness is active, but [App.tsx:370](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/App.tsx:370) only mounts them for Chats. Navigate to the workspace or make the destination visibly available. Add keyboard-accessible persisted right-panel resizing; its CSS exists without a mounted handle.
- Settings advertises Escape without owning an Escape/focus lifecycle; use one modal primitive with focus restoration, keyboard containment, and shortcut suppression. Evidence: [SettingsPanel.tsx:453](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/components/SettingsPanel.tsx:453), [App.tsx:228](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/App.tsx:228).
- App and Chat both display the same error. Assign one owner per error scope and provide actionable recovery. Harness monitor auto-scrolls on every event; preserve a reader’s position and offer Jump to latest. Evidence: [Chat.tsx:493](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/components/Chat.tsx:493), [HarnessPanel.tsx:189](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/components/HarnessPanel.tsx:189).
- Add named attachment-remove controls, keyboard rename, proper tab/panel semantics, and a normal Close-button focus loop in shortcut help. Avoid nested session rename input/button interactions.
- OpenCode startup failure currently replaces the shell. Keep Diagnostics/Providers/Settings available so users can repair setup from the app. Show Quick Entry’s project/session/model destination before sending.
- Do not accept the worker’s suspected permanently disabled permission-prompt finding as confirmed: [uiSlice.ts:81](D:/AI/projects/Dev/opencode-desktop/src/renderer/src/lib/slices/uiSlice.ts:81) removes and restores the prompt on IPC failure, which normally remounts its local state. This needs a UI test before calling it a defect.

## Recommended provider strategy

Use one main-owned descriptor registry for secure key slots, provider identity, endpoint/transport, model catalog provenance, capability support, context limits, billing class, errors, and health. Primary coding remains OpenCode-backed where possible; expose direct adapters only where they add concrete capabilities. Both paths must share policy, route decisions, usage, and run identity. Do not introduce renderer HTTP or a second SDK client/SSE subscriber.

| Provider | Current desktop/direct harness | Proposed integration work |
| --- | --- | --- |
| Gemini | Both present, incomplete direct lifecycle | Preserve native parts/signatures; streaming and cancellation; model-specific generation controls. [Function calling](https://ai.google.dev/gemini-api/docs/function-calling) |
| NanoGPT | Both present, subscription-focused UI | Separate subscription coverage from paid route; preserve route/caching settings; streaming and truthful usage. [Chat reference](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion) |
| Groq | Current managed linkage/direct harness absent | Restore secure descriptor; adapter capability and error fixtures; distinguish local function calls from provider-run tools. [Tool use](https://console.groq.com/docs/tool-use/overview) |
| Mistral | Current managed linkage/direct harness absent | Restore secure descriptor; native tool schemas/results and model capability checks. [Function calling](https://docs.mistral.ai/studio/conversations/function-calling) |
| OpenRouter | Current managed linkage/direct harness absent | Distinguish model routing from upstream-provider routing; expose upstream choice/privacy policy and parameter support. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) |
| Moonshot | Current managed linkage/direct harness absent | Add dedicated identity/credential/transport; multi-turn tool history fixtures. [Official tool guidance](https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md) |
| xAI | Current managed linkage/direct harness absent | Add descriptor; distinguish client-run functions from hosted tools and selected API transport. [Function calling](https://docs.x.ai/developers/tools/function-calling) |
| Cerebras, presumed | Current managed linkage/direct harness absent | Restore descriptor; validate strict schema and tool-call history requirements per model. [Tool calling](https://inference-docs.cerebras.ai/capabilities/tool-use) |
| Previously cataloged providers/local/custom | Prior entries removed or outside current key gate | Inventory and restore deliberately; distinguish remote key auth from local/no-key authorization. No user demand yet to prioritize local models. |

Official documentation was opened for this assessment. It establishes integration requirements, not that your accounts/models are authenticated, entitled, billed correctly, or working in this app. Avoid freezing current model names/prices into routing policy; refresh capabilities with provenance and preserve accepted cached data on refresh failure.

## Balanced, explainable routing

Make routing a main-owned decision, with a pure scoring helper and a visible explanation. The renderer chooses an objective and displays the returned result. Start with deterministic rules; add a classifier only when measured task diversity justifies its cost.

1. **Filter first:** project provider allowlist, valid auth, model availability, tool/vision/context requirements, privacy restrictions, approved billing class, quota/cooldown, and remaining budget. Unknown price is unknown, not zero.
2. **Rank eligible candidates:** task-specific quality prior with provenance, observed successful tool outcomes, estimated marginal task cost, TTFT/throughput, and reliability. Use confidence and a sensible exploration policy; a new provider with no data should not automatically beat measured providers.
3. **Reserve and pin:** reserve shared account limits before dispatch. Keep a stable route for a tool sequence unless a safe failover boundary permits switching. Account for caching and conversation migration cost.
4. **Explain every selection:** show selected provider/model, task fit, cost estimate or unknown, observed speed/confidence, main reason, two alternatives, exclusion reasons, and fallback. Avoid a fabricated exact “quality score.”
5. **Escalate intentionally:** retry only safe failures, distinguish provider/transport/local-tool errors, retain effective policy, and ask before crossing a project’s paid-spend ceiling or unapproved provider boundary.

Suggested UI: `Auto · Balanced` beside the effective model, expandable `Why this model?`, and `Override for this task`. Keep route history visible when a model changes. Example explanation: “Selected for tool support and this edit scope; comparable alternatives are cooling down; price estimate unavailable.” That is a template, not a measured current route.

## Custom subagents and automatic recommendations

Separate an **agent preset** from a **run assignment**. Presets define reusable role/prompt defaults; assignments contain an immutable task, model/provider, generation settings, permitted paths, tools, autonomy, budget, dependencies, and workspace. Never silently discard advanced settings or imply an unenforced control works.

Useful first presets: Explorer (read only), Planner (read only), Builder (one contained write scope), Reviewer (read only), Test runner (bounded approved commands), and Docs/UI specialist. Recommend zero extra agents for a trivial change; recommend a reviewer for risky boundaries; add independent workers only when scope and budget support useful parallelism.

Show the proposal before launch: roles, responsibilities, model choices, why each is useful, approved tools, dependencies, expected provider charges or uncertainty, and file ownership. Let users remove/add roles, lock a preferred model, clone a preset, or save the team recipe. Concurrent writers need separate worktrees or strictly exclusive file ownership; the coordinator owns integration and verification.

The main scheduler should enforce per-project/per-provider concurrency, cancellation, dependencies, quota reservations, artifact handoff, cleanup, and a global Stop all. Keep parent/child autonomy inherited, with explicit narrower overrides. Persist a redacted run journal and mark interrupted runs as needing recovery after restart; do not replay a side-effecting tool blindly.

## Features and quality-of-life priorities

| Priority | Addition | User value |
| --- | --- | --- |
| Next | Unified task timeline: plan → tools/approvals → changes → verification → result | Chat, harness, and child work have one readable story |
| Next | Project policy profiles: Read only, Ask before changes, Workspace edits/ask for shell | Effective autonomy is obvious and inherited consistently |
| Next | Route explanations, editable provider pool, cost uncertainty and budget guard | Automatic choices feel understandable and controllable |
| Next | Agent editor with Basic/Advanced sections, lossless clone, team recipes | Customization becomes dependable rather than a narrow form |
| Next | Recoverable provider/setup diagnostics with safe redacted export | Missing CLI, bad credentials, rate limits, and outages become actionable |
| Next | Persistent run history, interruption recovery, Stop all, bounded output | Long tasks remain manageable across app restarts |
| Soon | Workspace layout presets, adjustable panes, density/font/theme settings | Comfortable daily use on different displays |
| Soon | Draft preservation per task; follow-scroll toggle; keyboard rename/search | Fewer lost edits and less navigation friction |
| Soon | Diff-first approval with stale-file checks and validation results | Users can understand and review agent changes |
| Later | Shared MCP tools across execution paths, browser/remote/local model workflows | Broader harness capabilities after core policy/lifecycle reliability |
| Later | Opt-in evaluation feedback and task-specific router calibration | Recommendations improve from measured outcomes |

Keep Images/Live/Leroy in a secondary Tools area. They can remain useful features without competing with coding, approvals, and review in the primary navigation.

## Dark UI concepts

These are proposed interfaces with illustrative task/team content, not screenshots of the existing application or claims of live providers. Interactive actions are local previews.

- **Selected direction: Copper Focus.** You selected this concept in the design picker. Carry it forward as the primary interface: quiet project/task navigation, a readable conversation as the main work surface, and a compact team and project-policy inspector. Place route rationale beside the composer; keep advanced provider and agent setup nearby without crowding chat.
- **Copper Focus — visual treatment:** layered warm charcoal surfaces, terracotta for active and approval states, calm serif task headings, clear diff rows, and compact labels. Show the inherited project policy as a named choice and expand routing details on request.
- **Obsidian Studio — review mode:** explorer, proposed patch/editor, agent conversation, and a verification area. Deep neutral charcoal with copper. Useful when the task reaches changes/testing; adapt panes on narrow screens.
- **Plum Collective — team planning mode:** a proposed role/dependency plan beside project autonomy/concurrency/routing controls. Warm aubergine and muted rose. Useful before a multi-agent run; avoid turning every chat into a dashboard.

Keep Studio as the review mode and Collective as the team setup surface. Let both share Copper Focus's task, policy, and run context. Preserve the existing CSS contract token names and warm palette constraints. Provide accessible contrast, native keyboard focus, reduced motion, and theme/density previews. The mockups include accent/corner design controls for comparison.

## Bounded implementation sequence

| Milestone | Scope | Acceptance |
| --- | --- | --- |
| M0: correctness and release gates | Execution policy, empty tools, Stop, retry policy/side-effect guard, profile round-trip, contract/audit triage | Real executor cannot bypass policy; no post-cancel tool; real lifecycle tests; typecheck/lint/coverage/contracts/audit pass |
| M1: provider foundation | Shared descriptor/auth/capability/billing registry; restore requested primary-chat providers | Each provider has explicit discovered/configured/tested states; no credentials in renderer/tools; redacted tool-call smoke fixture per adapter |
| M2: unified project execution | Policy/approval broker, run/process ownership, shared usage, persisted redacted journal | Same policy across chat/harness/children; restart/cancel/approval expiry integration tests; truthful outcomes |
| M3: explainable router | Eligibility first, task requirements, balanced objectives, route records, shared quotas/spend reservation | Candidate rejection reasons, safe fallback, unknown-price handling, visible override; measured routing fixtures |
| M4: configurable teams | Agent editor, recommendations, scheduler, worktree ownership, coordinator verification | No overlapping concurrent writes; dependency/concurrency/budget/cancel proofs; editable recommendation before launch |
| M5: workspace redesign | Implement selected Copper Focus as the default task workspace; Studio review and Collective setup share project policy/run context; organized settings and responsive panes | Mounted/routed controls; keyboard/focus/shortcut tests; 780px/zoom layout; complete read/edit/approve/test/recover journey |
| M6: release proof | Package current build, launch and focus checks, updater/installer validation | Fresh Windows executable startup, CLI failure recovery, DPAPI/provider behavior, child cleanup, visible UI proof |

M0 precedes expanded autonomy. M1–M3 establish the shared foundation for M4. UI work can start from the reviewed mockups, but must expose only controls with enforced semantics.

## Reconciliation with existing plans

Keep [the existing NanoGPT M0–M9 plan](D:/AI/projects/Dev/opencode-desktop/docs/plans/nanogpt-agentic-harness/PLAN.md) as a useful architecture/verification source. Its policy broker, run persistence, coding timeline, OpenCode bridge, and scheduler stages remain relevant. Its subscriber-only boundary and narrowed two-provider BYOK surface conflict with this interview’s broader brief and need explicit revision in the eventual implementation spec. Preserve NanoGPT subscription safeguards as one project/provider billing policy rather than the whole app’s product boundary. This assessment does not overwrite that plan or ongoing Leroy work.

The next recommended action is a bounded M0 specification and fix pass, followed by the provider foundation and the selected Copper Focus redesign.
