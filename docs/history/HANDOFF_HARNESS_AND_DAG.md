# Handoff — Broad-Spectrum Multi-Provider Harness & Multi-Agent DAG Workflow Engine

**Date:** October 2026  
**Repo:** `C:\Users\Hp\Dev\opencode-desktop`  
**Branch:** `harness`  
**Current Baseline Status:**
- `npm run typecheck` → **Clean (0 errors)**
- `npm run lint` → **Clean (0 errors, 136 baseline warnings)**
- `node scripts/check-contracts.mjs` → **Clean (0 drift across 114 bridge methods & 112 IPC channels)**
- `npm run test` → **2,114 / 2,114 tests passing across 114 test files (100% green)**

---

## 1. Executive Summary

This phase delivered a major overhaul of OpenCode Desktop's standalone Agentic Harness (`src/main/harness/`) and introduced a production-grade Multi-Agent Directed Acyclic Graph (DAG) Workflow Engine (`src/main/harness/dag/`).

1. **Broad-Spectrum Multi-Provider Harness**: Upgraded the harness from supporting 2 providers with polling/batch responses to a 12-provider streaming engine with native adapters (Anthropic, OpenAI, Gemini, OpenAI-Compatible, NanoGPT) supporting real-time token/thinking streaming (`onDelta`), loop detection, context truncation, malformed JSON recovery, and budget hard-stops.
2. **Resilient Tool Suite**: Hardened all builtin tools with automatic directory creation (`fs_write`), targeted block replacement (`fs_patch`), pure Node.js recursive regex fallback (`grep`), binary file null-byte guards (`fs_read`), and tree-kill timeouts (`shell`).
3. **Declarative Multi-Agent DAG Engine**: Implemented a standalone DAG orchestrator supporting parallel wave execution via Kahn's topological sorting, 3-color DFS cycle path tracing, prototype-safe template interpolation (`{{inputs.<node>.output}}`), hierarchical cancellation, failure routing (`abortOnFail`, `skipOnFail`), and path-contained workflow loading.
4. **User Interface**: Updated `HarnessPanel.tsx` with a provider selector for all 12 providers, curated model presets, custom `baseUrl` configuration for local LLMs (Ollama / LM Studio), BYOK key status detection, streaming indicator badges, collapsible thinking blocks, and categorized tool pill cards.

---

## 2. Architecture & Modules Completed

### 2.1 Provider Adapters (`src/main/harness/providers/`)

All adapters implement `ProviderAdapter` and support both single-turn batch execution and streaming token deltas via `ChatOptions.onDelta?: (delta: ChatDelta) => void`:

- **`adapter.ts`**:
  - Defined `ChatDelta` (`{ type: 'text' | 'thinking', text: string }`).
  - Added `baseUrl?: string` to `ProviderConfig`.
  - Added `onDelta` callback to `ChatOptions`.
- **`anthropic.ts`** (`Native Anthropic Messages API`):
  - Direct HTTP streaming to `https://api.anthropic.com/v1/messages` using `anthropic-version: 2023-06-01`.
  - Converts tool declarations to Anthropic `input_schema` format.
  - Handles SSE events (`content_block_start`, `content_block_delta`, `thinking_delta`, `text_delta`).
  - Emits thinking tokens and text tokens via `onDelta`.
  - Maps tool responses back to `tool_result` content blocks.
- **`openai.ts`** (`Native OpenAI API`):
  - Direct streaming to `https://api.openai.com/v1/chat/completions`.
  - Adapts reasoning models (`o1`, `o3-mini`): switches `max_tokens` to `max_completion_tokens`, omits unsupported temperature parameters, and translates system prompts to `developer` role.
  - Emits token deltas in real-time.
- **`gemini.ts`** (`Google GenAI SDK`):
  - Fixed correlation ID bug in multi-turn tool conversations: mapped function call name accurately back to declaration name in `functionResponse` parts.
  - Grouped contiguous tool responses into a single turn with `role: 'user'` as required by `@google/genai`.
  - Implemented streaming via `ai.models.generateContentStream`.
- **`openaiCompatible.ts`** (`Groq, Mistral, Cerebras, DeepSeek, Moonshot, xAI, OpenRouter, Custom`):
  - Fixed HTTP 400 Bad Request error across strict OpenAI-compatible engines by formatting assistant messages containing `tool_calls` with `content: ""` instead of `null`.
  - Added support for custom `baseUrl` (allowing integration with local Ollama, LM Studio, vLLM, and Jan).
- **`thinkTagStreamer.ts`** (`Real-Time Thinking Parser`):
  - Stream parser that intercepts `<think>...</think>` tags on raw token streams (e.g., DeepSeek R1, Qwen Thinking) and splits deltas into `{ type: 'thinking' }` and `{ type: 'text' }`.
- **`nanogpt.ts`**:
  - Upgraded with SSE stream parsing and real-time delta emission.
- **`registry.ts`**:
  - Registered all 12 provider IDs: `nanogpt`, `google`, `anthropic`, `openai`, `openrouter`, `groq`, `mistral`, `deepseek`, `moonshot`, `xai`, `cerebras`, `custom`.

### 2.2 Execution Loop Hardening (`src/main/harness/runner.ts`)

- **Real-Time UI Streaming**: Wire `onDelta` to emit `harness:delta` events over WebContents IPC so the user sees thoughts and tokens appear immediately.
- **Tool Output Truncation**: Caps individual tool outputs inserted into message history at 30,000 characters with an explicit notification string (`[Output truncated at 30000 characters. 1234 characters omitted]`).
- **Rolling Loop Detector**:
  - Tracks canonical `tool_name:canonical_args` invocations.
  - Emits a system warning message to the model on 3 consecutive identical tool calls.
  - Hard-intercepts on the 4th consecutive identical tool call to prevent infinite spin loops.
- **Malformed JSON Recovery**: Catches `JSON.parse` failures on model-generated tool arguments and returns a descriptive error message to the model so it can correct its payload on the subsequent turn.
- **Budget Hard-Stops**: Enforces `maxTurns` and `tokenBudget` before initiating each turn, immediately halting the run if exceeded.
- **Hierarchical Cancellation**: Propagates `AbortSignal` through all HTTP fetches and subprocesses.

### 2.3 Resilient Builtin Tools (`src/main/harness/tools/builtins.ts`)

- **`fs_write`**: Auto-creates parent directories recursively (`mkdir(dirname(abs), { recursive: true })`) before writing.
- **`fs_patch`**: New targeted search-and-replace tool with exact occurrence verification and optional `allowMultiple` flag.
- **`grep`**: Pure Node.js recursive regex fallback when `rg` (ripgrep) is not installed or fails on the host machine.
- **`shell`**: Added 60-second default timeout and clean process-tree termination via `killProcessTree` (`taskkill /T /F` on Windows).
- **`fs_read`**: Reads binary files safely by sampling the first 8 KB for null bytes, returning `[Binary file, size: X bytes]` instead of garbled text or crashing.

### 2.4 Multi-Agent Directed Acyclic Graph (DAG) Engine (`src/main/harness/dag/`)

- **`types.ts`**: Comprehensive type declarations for DAG workflows, node dependencies, execution policies, node outputs, and handoff contracts.
- **`validator.ts`**:
  - Schema and invariant validation.
  - Cycle detection using 3-color Depth First Search (`WHITE`/`GRAY`/`BLACK`) that reconstructs the exact cycle path (e.g. `A -> B -> C -> A`).
  - Topological partitioning using Kahn's algorithm to compute concurrent execution waves (e.g., Wave 0: root nodes, Wave 1: dependent nodes).
- **`interpolator.ts`**:
  - Safe template parameter substitution using regex: `{{inputs.<nodeId>.<path>}}`.
  - Protected against Prototype Pollution (`__proto__`, `constructor`, `prototype`).
- **`runner.ts` (`DagRunner`)**:
  - Executes workflows wave-by-wave, running independent nodes concurrently (`Promise.allSettled`).
  - Failure routing policies: `abortOnFail` (stops entire DAG) vs `skipOnFail` (skips downstream dependents while continuing other branches).
  - Emits granular events (`workflow:start`, `node:start`, `node:complete`, `node:error`, `workflow:complete`).
- **`controller.ts` (`DagController`)**:
  - Manages active DAG runs, state persistence, cancellation, and pause/resume mechanics.
- **`workflowLoader.ts`**:
  - Path-contained discovery and validation of declarative workflow files located in `{project}/.opencode/workflows/*.json`.
- **`index.ts`**:
  - Barrel export for the DAG engine.

### 2.5 UI & Electron IPC Hardening

- **`src/renderer/src/components/HarnessPanel.tsx` & `.css`**:
  - Provider selector dropdown with all 12 providers.
  - Dynamic model presets per provider (e.g., Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq Llama 3.3).
  - Base URL configuration input when `custom` provider is chosen.
  - Warning badges indicating missing BYOK keys with cross-reference to `window.api.keys.list()`.
  - Collapsible `<details>` element for reasoning/thinking blocks with live animated indicators.
  - Clean tool cards categorized by read/write/shell permissions.
- **Contracts & Security**:
  - `CONTRACTS.md` updated with `baseUrl?: string` on `AgentProfile`.
  - `keys.ts`, `providerCatalog.ts`, and `env.ts` updated with Anthropic, OpenAI, and DeepSeek credentials.
  - Verified with `node scripts/check-contracts.mjs`.

---

## 3. Test Suites & Verification Results

All tests run via `vitest` under Node.js environment.

### 3.1 Test Summary
- **Total Test Count**: **2,114 tests**
- **Passing**: **2,114 tests (100%)**
- **Test Files**: **114 files**

### 3.2 Specific Harness & DAG Suites
| Suite | File | Tests | Status |
| :--- | :--- | :--- | :--- |
| Harness E2E Scenarios | `src/main/__tests__/harnessE2E.test.ts` | 33 | PASS |
| Harness Providers | `src/main/__tests__/harnessProviders.test.ts` | 44 | PASS |
| Harness Runner & Loop | `src/main/__tests__/harnessRunner.test.ts` | 38 | PASS |
| Harness Builtin Tools | `src/main/__tests__/harnessBuiltinTools.test.ts` | 52 | PASS |
| DAG Validator & Kahn | `src/main/__tests__/dagValidator.test.ts` | 28 | PASS |
| DAG Interpolator | `src/main/__tests__/dagInterpolator.test.ts` | 24 | PASS |
| DAG Runner Waves | `src/main/__tests__/dagRunner.test.ts` | 32 | PASS |
| DAG Controller Lifecycle | `src/main/__tests__/dagController.test.ts` | 26 | PASS |
| DAG Workflow Loader | `src/main/__tests__/dagWorkflowLoader.test.ts` | 18 | PASS |
| DAG Adversarial / Invariants | `src/main/__tests__/dagInvariantChallenger.test.ts` | 35 | PASS |
| DAG Stress & Concurrency | `src/main/__tests__/dagStressChallenger.test.ts` | 30 | PASS |
| DAG E2E Tiers | `src/main/__tests__/dagE2ETiers.test.ts` | 26 | PASS |

---

## 4. Invariants & Security Rules (Do Not Violate)

1. **BYOK Keys Never Leak**:
   - Keys are stored encrypted via Electron `safeStorage` in `userData/byok-keys.json`.
   - Never write keys to `harness-profiles.json`, workflow definitions, or debug logs.
   - `listKeys()` returns masked strings (last 4 characters only).
2. **Subpath Containment**:
   - Every file read, write, and patch must pass through `assertSubpath` from `src/main/projectsPaths.ts`.
   - Workflows must not read or execute outside the designated workspace root.
3. **Process Tree Termination**:
   - Shell commands spawned by tools or runners must be reaped using `killProcessTree` (`taskkill /T /F` on Windows) to prevent orphaned background processes.
4. **Contract Synchronization**:
   - Every IPC channel must exist in `CONTRACTS.md`, `src/preload/index.ts`, and `src/preload/index.d.ts`. Always verify with `node scripts/check-contracts.mjs`.

---

## 5. Next Planned Horizons

1. **Visual DAG Canvas UI (`DagPanel.tsx`)**:
   - Build a visual React node graph editor in the renderer for dragging, connecting, and viewing multi-agent DAG execution in real time.
2. **Workflow File Templates**:
   - Provide built-in workflow templates in `.opencode/workflows/` (e.g., Code Reviewer -> Test Writer -> Fixer pipeline).
3. **OpenCode Serve Bridge Provider**:
   - Add an adapter that allows harness nodes to invoke the local `opencode serve` child process directly for specialized operations.
