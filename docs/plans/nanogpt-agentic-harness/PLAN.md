# NanoGPT Agentic Coding Harness — implementation plan

Status: plan-only, based on branch `harness` at `ebcbf67` plus the existing uncommitted Leroy/live-screen work. This plan does not authorize product-code edits in the current wave.

## 1. Outcome and product boundary

Turn OpenCode Desktop into a NanoGPT-subscriber coding harness with the working loop users expect from Claude Code Desktop:

1. choose a project and model;
2. describe a coding task in a persistent session;
3. let the agent inspect, plan, and ask before side effects;
4. review streamed reasoning, tool calls, diffs, tests, and terminal output;
5. approve/reject changes at file or command scope;
6. pause, cancel, resume, or recover a run;
7. finish with a verifiable diff, test result, and usage record.

The existing architecture is binding and remains:

```text
React renderer  <-- typed contextBridge IPC -->  Electron main
                                                  |-- OpenCode SDK/SSE (interactive coding path)
                                                  |-- harness coordinator (plans, policies, durable runs)
                                                  `-- transient NanoGPT HTTPS adapter
```

The OpenCode `serve` path stays the primary interactive coding executor because it already owns sessions, permissions, diffs, subagents, compaction, and SSE. The direct harness becomes the coordinator and controlled adapter for NanoGPT-specific workflows, planning/review agents, and future DAG orchestration. Do not create a second unapproved filesystem/shell authority beside OpenCode.

NanoGPT subscriber mode is the first supported product mode. All model discovery and coding requests use the subscription-scoped catalogue and endpoint. Pay-as-you-go and x402 are explicit future products, not silent fallbacks.

## 2. Evidence baseline

| Capability | Current state | Evidence / implication |
|---|---|---|
| Profiles and persistence | Implemented | `src/main/harness/profiles.ts:8-53`, `profileStore.ts:28-133`; built-ins are merged at read time. |
| Agent loop | Implemented but single-agent | `src/main/harness/runner.ts:50-243`; hard max turns/tool rounds and input-token budget exist. |
| NanoGPT adapter | Partial | `src/main/harness/providers/nanogpt.ts:107-235`; it sends `stream: false`, duplicates transport/error handling, and permits `billingRoute: 'standard'`. |
| Provider interface | Partial | `src/main/harness/providers/adapter.ts:44-87` has `chat/abort/probe`, despite a `ChatDelta` type; no streaming/error/billing contract. |
| Tools | Partial and unsafe for production | `src/main/harness/tools/builtins.ts:50-229` has contained reads and capped output, but writes lack `baseSha`, shell has no approval/timeout/abort/sanitized env, and `web_fetch` only checks URL scheme. |
| Approval boundary | Absent in direct harness | OpenCode permissions exist through `oc:permission:reply` (`CONTRACTS.md:133-134`), but harness tool calls do not enter that broker. Leroy approval UI is a separate sidecar path. |
| Run state | In-memory only | `src/main/harness/controller.ts:34-180`; process restart loses active/history context and the renderer has no resume/checkpoint API. |
| IPC and UI reachability | Implemented | `src/main/ipc.ts:1342-1384`, `src/preload/index.ts:878-895`, `App.tsx:420-425,493-496`, `Sidebar.tsx:227-269`; currently a separate Harness view with one Run/Stop flow. |
| OpenCode sessions/subagents/diffs | Implemented in primary path | SDK calls and SSE are documented in `CONTRACTS.md:29-39,91-97`; renderer already has `Chat`, `ToolCall`, permission queue, subagent tabs, `ChangesPanel`, editor, terminal, and git slices. |
| BYOK | Implemented | `src/main/keys.ts:143-157,219-269`, `src/main/env.ts:26-69,212-227`; preserve this boundary and never return key material. |
| NanoGPT catalogue/config | Implemented for serve path | `src/main/nanogptConfig.ts:159-215`, `server.ts:376-386`; cached subscription models are injected as `{env:NANOGPT_API_KEY}`. |
| Quality baseline | Typecheck passes in this wave | `cmd.exe /c npm run typecheck` passed on 2026-08-27. Full test/lint/build gates remain to be run after plan implementation. |

## 3. Non-negotiable contracts

### Runtime and state

- Main owns all provider keys, server clients, run state, policy decisions, child processes, and durable ledgers.
- Renderer imports only types from `@opencode-ai/sdk` and communicates through `window.api`.
- Keep one OpenCode SSE subscription and rebroadcast events verbatim on `oc:event`; add one typed harness event stream only for coordinator events.
- Every run has a stable `runId`, `sessionId` (when backed by OpenCode), project directory, profile snapshot, parent run, checkpoint sequence, cancellation state, and terminal outcome.
- IPC inputs are validated in main with existing containment and string/object validators. Update `CONTRACTS.md` in the same change as any channel/type change.

### Subscriber and billing safety

- NanoGPT adapter is pinned to `/api/subscription/v1/chat/completions`; remove `standard` from the subscriber-facing profile/IPC shape.
- A model is runnable only if it is present in the subscription cache or a freshly verified subscription catalogue and supports the requested capability (especially `tool_calling`).
- Never treat unknown cost as zero. Show `subscription covered`, `paid`, or `unknown`; only render a spend amount when the provider supplies authoritative data.
- Any future paid mode requires a separately named policy, explicit confirmation, separate tests, and an auditable route decision.

### Side effects and secrets

- Read operations may run automatically within the contained project.
- Writes, shell, network, custom tools, and destructive git operations require a main-process approval broker; default NanoGPT profiles to read-only.
- Writes are staged or `baseSha`-checked, atomic, and surfaced as diffs before apply.
- Shell/custom processes use allowlisted environment variables, contained cwd, timeout, abort-aware process-tree kill, bounded streaming output, and no `NANOGPT_API_KEY`.
- Web tools resolve DNS and reject loopback, link-local, RFC1918, metadata, and redirect-to-private targets; enforce byte limits while reading.
- Keys may appear only transiently in the main-process request header and the OpenCode child’s allowlisted environment. They must not enter profiles, events, logs, crash reports, tool environments, or test snapshots.

## 4. Modules, ownership, dependencies, and acceptance

### M0 — Contract freeze and vertical-slice test fixture

Target files: `CONTRACTS.md`; new `src/main/harness/contracts.ts`; `src/preload/index.ts`; `src/preload/index.d.ts`; `src/renderer/src/lib/types.ts`; `src/main/__tests__/harnessContract.test.ts`; `scripts/check-contracts.mjs` only if required.

Define canonical types for `HarnessRun`, `HarnessEvent`, `ApprovalRequest`, `ProviderError`, `Usage`, `BillingRoute`, `ToolPolicy`, checkpoint/recovery, and terminal reasons. Add a deterministic fake NanoGPT server/adapter fixture that emits normal, tool-call, malformed, retry, and cancellation cases. Version the contract so old persisted profiles/run records migrate safely.

Acceptance: preload, renderer mirrors, and `CONTRACTS.md` agree; hostile IPC payloads are rejected; fixture proves no secret-bearing field can cross the bridge. Verify `npm run typecheck`, `node scripts/check-contracts.mjs`, and focused contract tests.

### M1 — NanoGPT transport and streaming adapter

Target files: new `src/main/nanogptTransport.ts` (or extracted shared module); `src/main/harness/providers/adapter.ts`; `src/main/harness/providers/nanogpt.ts`; `src/main/nanogpt.ts` only for shared error/usage types; `src/main/__tests__/nanogpt*.test.ts`; `src/main/__tests__/harnessNanoGpt.test.ts`.

Unify key resolution, auth headers, timeouts, retry classification, jitter, `Retry-After`, `X-Request-ID`, provider error `code`, redaction, usage, and subscription billing metadata. Implement an abort-aware SSE decoder supporting multiline `data:`, `[DONE]`, content/reasoning deltas, usage-only terminal chunks, fragmented and parallel tool-call arguments, malformed JSON, premature close, and no post-abort retry. Validate model/capability against the subscription cache before sending.

NanoGPT’s current docs describe OpenAI-compatible tool calls and subscription endpoint variants; they also describe streaming reasoning in `delta.reasoning` and tool results keyed by `tool_call_id` ([chat completion reference](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion), [models reference](https://docs.nano-gpt.com/api-reference/endpoint/models)). Treat usage/limits as live-contract data: the repository handoff records that the vendored subscription-usage shape was wrong, so capture redacted live payload keys before changing parsers.

Acceptance: subscriber profiles cannot select standard billing; streamed text and tools round-trip; 401/402/429/408/500/503 and malformed streams produce stable redacted structured errors; valid request IDs survive; cancellation works during fetch, stream, backoff, and tool handoff. Verify focused tests plus typecheck.

### M2 — Unified policy and approval broker

Target files: new `src/main/harness/policy.ts`, `src/main/harness/approvals.ts`, `src/main/harness/audit.ts`; `src/main/harness/tools/registry.ts`; `src/main/harness/tools/builtins.ts`; `src/main/harness/tools/custom.ts`; reuse `src/main/configService.ts`, `src/main/projectsPaths.ts`, `src/main/fsService.ts`; new main tests.

Replace automatic side effects with a capability policy: `read`, `write`, `edit`, `shell`, `network`, `custom`, and `git`. Route each non-read call to a broker that emits `approval.requested`, pauses the runner, accepts once/always/reject with scope and expiry, and records a hash-chained audit entry without raw secrets or unbounded output. Reuse OpenCode permission semantics where the executor is an OpenCode session; never invent a second renderer-only permission authority.

Use `fsService`-style `baseSha`/atomic writes or staged patches. Add symlink/junction canonicalization before containment. Add shell/custom timeout, abort signal, sanitized env, process-tree termination, and output backpressure. Harden web fetch against SSRF and redirects.

Acceptance: read-only profiles cannot mutate; every write/shell/network call is visibly approved or denied; stale files cannot be clobbered; approval expiry and restart behavior are deterministic; audit entries are tamper-evident and secret-free. Verify path traversal, junction escape, command timeout/kill, env redaction, SSRF, approval replay, and concurrent-write tests.

### M3 — Durable run/session coordinator

Target files: `src/main/harness/controller.ts`; `src/main/harness/runner.ts`; `src/main/harness/profileStore.ts`; new `src/main/harness/runStore.ts`, `checkpoint.ts`, `events.ts`, `recovery.ts`; `src/main/index.ts`; `src/main/ipc.ts`; preload declarations/bridge; renderer `harnessSlice.ts`; contract/tests.

Split the current fire-and-forget map into a coordinator with a state machine: `queued → planning → awaiting_approval → executing → paused → resuming → completed|failed|cancelled|needs_recovery`. Persist run metadata, event sequence, message/tool transcript references, approvals, token usage, and checkpoints under app user data with atomic writes and bounded retention. On startup, mark interrupted runs `needs_recovery`; offer resume from the last checkpoint or safe discard. Make stop idempotent and ensure no events arrive after terminal state.

Add IPC for `run.get`, `run.list`, `run.pause`, `run.resume`, `run.cancel`, `run.approvals`, and `run.events` only after contract freeze. Keep compatibility shims for existing `start/stop/status/list` until the renderer migrates.

Acceptance: kill/restart recovery preserves a redacted transcript and exact terminal reason; duplicate/reordered events are harmless; pause works at provider, approval, and tool boundaries; cancellation kills children and releases limiter slots. Verify state-machine/property tests and a process-restart integration fixture.

### M4 — Claude Code-style interactive coding session

Target files: `src/renderer/src/components/Chat.tsx`, `Composer.tsx`, `ToolCall.tsx`, `PermissionPrompt.tsx`, `ChangesPanel.tsx`, `EditorPanel.tsx`, `TerminalPanel.tsx`, `GitPanel.tsx`; new `RunTimeline.tsx`, `ApprovalQueue.tsx`, `PlanPanel.tsx`, `RunRecoveryDialog.tsx`; styles; `src/renderer/src/lib/slices/{session,event,harness,git,editor,terminal}.ts`; main IPC/contract additions.

Promote the existing Harness view from a separate one-shot form into a task mode attached to a project/session. The first screen should show project, subscription model, permission preset, estimated/known usage, and a clear “read-only / ask / allow” state. Stream plan, reasoning (with a user-controlled visibility policy), tool call, approval, diff, test, and completion cards into one timeline. Put Stop/Pause/Resume/Retry beside the active run; preserve the existing Chat permission queue, subagent tabs, diff viewer, hunk staging, terminal, and git surfaces.

Do not show controls that imply unsupported persistence, multi-agent execution, or paid billing. Every error must distinguish missing key, subscription entitlement, rate limit, context limit, provider outage, and local tool failure.

Acceptance: a new user can open a folder, add/test a NanoGPT key, choose a subscription model, run a read-only inspection, approve one file edit, review a diff, run a test, and recover from a forced interruption without leaving the page. Verify keyboard navigation, focus return after dialogs, screen-reader labels, no shortcut collisions, responsive narrow-window layout, and a browser smoke test against a fake provider.

### M5 — OpenCode bridge and agentic workflow planner

Target files: new `src/main/harness/providers/opencodeBridge.ts`, `src/main/harness/workflows/{types,planner,executor}.ts`, `src/main/harness/dag.ts`; `src/main/server.ts`; `src/main/ipc.ts`; renderer `PlanPanel.tsx` and harness slice; tests.

Use OpenCode child sessions (`session.create({ parentID })`, `promptAsync`, existing SSE) for coding execution and subagents. The planner may use a NanoGPT subscription model to produce a typed plan, but execution is delegated to OpenCode so permissions, diffs, task children, compaction, and terminal policy have one authority. Add bounded DAG nodes with explicit inputs/outputs, max parallelism, cancellation propagation, dependency failure policy, and per-node model/tool policy. Start with sequential plan → implement → test → review; enable parallel read-only research/review only after the ledger and approval broker are stable.

Acceptance: a workflow can render its plan, require approval before execution, run two independent read-only nodes in parallel, serialize conflicting writes, cancel descendants, and show parent/child transcripts. Verify DAG cycle detection, deterministic scheduling, failure propagation, and OpenCode event routing.

### M6 — Context, compaction, and project memory

Target files: new `src/main/harness/context/{collector,compactor,memory}.ts`; `src/main/harness/runStore.ts`; `src/main/nanogptConfig.ts`; renderer context/plan components; tests; `CONTRACTS.md`.

Collect bounded project context from git status, selected files, instructions, prior run summaries, and approved artifacts. Use NanoGPT context/memory features only behind a capability flag and documented retention choice; otherwise compact locally with a deterministic summary and provenance. Never upload an entire workspace by default. Show what context was sent and what was omitted.

Acceptance: context stays below model limits, compaction is resumable and provenance-aware, secrets and ignored files are excluded, and users can clear stored run memory. Verify token-budget accounting, binary/large-file filtering, redaction, retention, and context-length error recovery.

### M7 — Usage, entitlement, and observability

Target files: `src/main/nanogpt.ts`, `nanogptBilling.ts`, `nanogptUsage.ts`, `nanogptLimiter.ts`, `tokenBudgetTracker.ts`; new `src/main/harness/usageLedger.ts`; renderer `StatusBar.tsx`, `SettingsPanel.tsx`, harness status cards; tests and `CONTRACTS.md`.

Make subscription entitlement, weekly input tokens, request limits, model route, retries, and unknown cost first-class ledger fields. Reconcile harness and OpenCode usage into one per-run record; never infer a dollar cost from a missing field. Add local diagnostic logs with correlation IDs only, opt-in and redacted. Add bounded metrics for time-to-first-token, tool latency, approval wait, retries, cancellation, and recovery.

Acceptance: the UI can say “covered”, “paid”, “unknown”, or “unavailable” correctly; 401/402/429 explanations are actionable; limiter slots release on every exit; logs contain no key, prompt secret, or tool output by default. Verify with mocked live payloads and current NanoGPT probes before release.

### M8 — Test pyramid, security review, and release gates

Target files: matching `src/main/__tests__/**`, `src/renderer/src/lib/__tests__/**`; new `e2e/` fixtures; `.github/workflows/ci.yml`; `vitest.config.ts`; `electron-builder.yml`; release documentation.

Add unit tests for validators, provider transport, SSE parsing, policy, path/symlink containment, redaction, state transitions, DAG scheduling, usage, and reducers. Add IPC contract tests for every new channel. Add component tests for approval/recovery/timeline states. Add Playwright smoke flows using a local fake NanoGPT/OpenCode server, a disposable project, and deterministic fixtures. Keep real-provider smoke tests secret-safe and opt-in.

Required gates, in order:

1. `npm run typecheck` (node and web);
2. `npm run lint` with no new errors/warnings beyond baseline;
3. `npm run test` and coverage thresholds ratcheted upward, not lowered;
4. `npm run check:contracts`;
5. fake-provider Playwright flow covering onboarding → read → approve edit → diff → test → cancel/recover;
6. Windows `npm run build`, `npm run dist:win:dir`, and clean-machine launch with visible focused window;
7. secret scan of source, logs, profiles, crash reports, packaged files, and test artifacts;
8. manual review of the complete combined diff and current worktree so Leroy/live-screen changes are not accidentally included.

Release is blocked until direct harness writes/shell are approval-gated, subscriber billing is invariant, streaming/cancellation are proven, recovery is tested, and the clean-machine artifact launches. Unsigned binaries remain a SmartScreen risk until code signing is funded.

### M9 — Private NanoGPT subscriber pilot

Pilot only after M0–M8 pass. Publish a private build and narrated technical demo, not a public hosted trial. Use disposable projects, a disposable or explicitly authorized subscriber key, visible “subscription mode”/“pre-production” labels, and a scripted task that demonstrates plan → approval → diff → test → recovery. Collect opt-in diagnostics and feedback on false approvals, model/tool failures, latency, quota messaging, and recovery.

Exit criteria: five representative repositories complete the vertical slice; no high-severity security findings; no unexplained key exposure; provider contract probes are captured; all release gates pass on a clean Windows machine; pilot feedback is triaged into a versioned follow-up plan.

## 5. Dependency graph and milestones

```text
M0 contract fixture
 ├── M1 NanoGPT stream/error/billing adapter
 ├── M2 policy + approval + tool gateway
 └── M3 durable coordinator/recovery
       ├── M4 interactive coding UX
       ├── M5 OpenCode bridge + bounded DAG
       ├── M6 context/compaction/memory
       └── M7 usage/observability
             └── M8 test/release gates
                   └── M9 private subscriber pilot
```

Milestone gates:

- **Alpha (M0–M2):** no unapproved side effects; subscription route invariant; fake provider stream/tool/error tests pass.
- **Vertical slice (M3–M4):** one real NanoGPT subscriber task can be planned, approved, executed through OpenCode, reviewed, tested, cancelled, and recovered.
- **Agentic beta (M5–M7):** typed plans, bounded child sessions, context provenance, unified usage, and durable audit/recovery.
- **Pilot release (M8–M9):** clean-machine Windows artifact, E2E evidence, security review, truthful product copy, and private rollout.

## 6. Decisions required before implementation

1. Is NanoGPT subscriber mode strictly subscription-only for the pilot, with paid mode excluded from the UI? Recommended: yes.
2. Should planner calls use direct NanoGPT while OpenCode executes coding sessions through the generated custom provider? Recommended: yes, with one shared transport/error contract.
3. Which approval preset is default? Recommended: read-only inspection, ask for writes/shell/network, and no persistent “always allow” until scope/expiry is visible.
4. What retention is acceptable for run transcripts and context summaries? Default to local, bounded, user-clearable retention; do not enable provider-side storage implicitly.
5. Which model capabilities are guaranteed by the subscription catalogue today? Verify live before adding built-in profiles; never ship hard-coded model IDs as entitlement proof.

## 7. Current-wave evidence and limitations

- `npm run typecheck` passed on 2026-08-27.
- This is a planning wave; no harness product code was changed. `PROGRESS.md` is the only planning ledger added, and the pre-existing Leroy/live-screen worktree changes remain untouched.
- Two requested audit lanes (architecture and UX/release) hit the account agent usage limit before reporting; their findings were independently reconstructed from the repository. The provider/security lane completed a read-only audit.
- NanoGPT documentation is current enough to anchor endpoint/tool/streaming design, but its subscription-usage shape conflicts with the repository handoff’s observed live payload. Live, redacted contract probes are a release prerequisite.
