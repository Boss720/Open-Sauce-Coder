# Project: OpenCode Serve Bridge & Built-in Workflows

## Architecture
- **OpenCode Serve Bridge Provider**: `src/main/harness/providers/opencodeBridge.ts` implementing `ProviderAdapter` (`id: 'opencode'`). Bridges harness turns directly to the local supervised `opencode serve` child process (`src/main/server.ts`) via SDK client `client.session.promptAsync`, streaming text and thinking deltas via SSE `message.part.updated` events (`onDelta`), and registering in `registry.ts`.
- **Built-in Workflow Templates**: Declarative JSON workflow templates under `.opencode/workflows/` (`code-review-fix.json` and `feature-implementation.json`) conforming strictly to `WorkflowDefinition` in `src/main/harness/dag/types.ts`. Validated via `validateWorkflow` in `validator.ts` into 3 clean topological waves with dependency handoff parameter interpolation (`{{inputs.<nodeId>.output}}`).
- **Workflow Discovery & Seeding**: `src/main/harness/dag/workflowLoader.ts` updated to merge project-level workflows with built-in templates (`BUILTIN_WORKFLOWS` in `builtinWorkflows.ts`) when `{ includeBuiltin: true }` is requested by IPC `oc:dag:listWorkflows`, while preserving default disk-only isolation for project test suites. `oc:dag:loadWorkflow(directory, workflowId)` takes a validated project directory (`requireDirectory`) plus a workflow id, never a renderer path, reads only under `.opencode/workflows/` (1 MiB cap), and falls back to built-in templates by id. Seamless integration with `DagPanel.tsx`.
- **Contract & Boundary Conformance**: Zero IPC contract drift, path containment via validated project directory + id lookup, clean TypeScript compilation, and 100% vitest pass (2,282 tests across 123 test files).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `OpencodeBridgeAdapter` implementation | Implements `ProviderAdapter` in `src/main/harness/providers/opencodeBridge.ts` with ephemeral session management, SSE event listener, and `onDelta` text/thinking streaming | M1 | Survey 1 / ORIGINAL_REQUEST R1 |
| 2 | Provider registration & profiles | Register `'opencode'` in `SUPPORTED_PROVIDERS` and `createAdapter` in `registry.ts`. Add `opencode-agent` built-in profile in `profiles.ts` and UI selector in `HarnessPanel.tsx` | M1 | Survey 1 / ORIGINAL_REQUEST R1 |
| 3 | Bridge Unit Tests | Test suite `src/main/__tests__/harnessOpencodeBridge.test.ts` covering single-turn, streaming tokens, thinking deltas, offline probe, and error handling with mock server seams | M1 | Survey 1 / ORIGINAL_REQUEST R1 |
| 4 | Built-in Workflow Templates Definitions | Implement `BUILTIN_WORKFLOWS` catalog in `src/main/harness/dag/builtinWorkflows.ts` for `code-review-fix` and `feature-implementation` conforming to `WorkflowDefinition` | M2 | Survey 2 / ORIGINAL_REQUEST R2 |
| 5 | Physical Workflow Files | Deliver git-tracked JSON files in `.opencode/workflows/code-review-fix.json` and `.opencode/workflows/feature-implementation.json` | M2 | Survey 2 / ORIGINAL_REQUEST R2 |
| 6 | Built-in Workflow Tests | Test suite `src/main/__tests__/dagBuiltinTemplates.test.ts` validating DAG schemas, Kahn topological wave partitioning, and acyclicity | M2 | Survey 2 / ORIGINAL_REQUEST R2 |
| 7 | Workflow Loader Discovery & Fallback | Update `listWorkflows` and `loadWorkflow` in `src/main/harness/dag/workflowLoader.ts` to merge project disk workflows with built-ins when `{ includeBuiltin: true }`, and export `seedBuiltinWorkflows` | M3 | Survey 3 / ORIGINAL_REQUEST R3 |
| 8 | IPC Handler Fallback | Update `oc:dag:loadWorkflow` in `src/main/ipc.ts` to enforce `assertSubpath` on disk paths and gracefully fallback to built-in templates by ID | M3 | Survey 3 / ORIGINAL_REQUEST R3 |
| 9 | DagPanel UI Compatibility & Loader Tests | Verify `DagPanel.tsx` auto-discovery and add vitest coverage in `src/main/__tests__/dagWorkflowLoader.test.ts` and `ipc.dag.test.ts` | M3 | Survey 3 / ORIGINAL_REQUEST R3 |
| 10 | Contract & Quality Gate Verification | Zero contract drift (`node scripts/check-contracts.mjs`), 0 typecheck errors, 0 lint errors, and 100% vitest suite pass | M4 | Survey 1-3 / ORIGINAL_REQUEST R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: OpenCode Bridge Provider | Implement `opencodeBridge.ts`, register in `registry.ts`, add profile in `profiles.ts`, update `HarnessPanel.tsx`, and add `harnessOpencodeBridge.test.ts` | none | DONE |
| 2 | M2: Built-in Workflow Templates | Implement `builtinWorkflows.ts`, write `.opencode/workflows/code-review-fix.json` and `.opencode/workflows/feature-implementation.json`, and add `dagBuiltinTemplates.test.ts` | none | DONE |
| 3 | M3: Discovery, Seeding & UI Integration | Update `workflowLoader.ts`, update `src/main/ipc.ts` fallback, verify `DagPanel.tsx` listing, and update loader/IPC tests | M2 | DONE |
| 4 | M4: Final Verification & Hardening | Full project verification: typecheck, lint, check-contracts, full vitest run, adversarial challenge, and forensic audit | M1, M2, M3 | DONE |

## Interface Contracts
### `src/main/harness/providers/opencodeBridge.ts`
- Implements `ProviderAdapter`:
  ```ts
  export interface OpencodeBridgeServerSeam {
    getStatus: () => ServerStatus
    getClient: () => OpencodeClient
    onEvent: (cb: (event: OpencodeEvent) => void) => () => void
  }
  export interface OpencodeBridgeAdapterOptions {
    serverSeam?: OpencodeBridgeServerSeam
    timeoutMs?: number
  }
  export class OpencodeBridgeAdapter implements ProviderAdapter {
    readonly id = 'opencode'
    chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse>
    abort(requestId: string): void
    probe(): Promise<boolean>
  }
  ```

### `src/main/harness/dag/builtinWorkflows.ts`
- Exports:
  ```ts
  export const CODE_REVIEW_FIX_WORKFLOW: WorkflowDefinition
  export const FEATURE_IMPLEMENTATION_WORKFLOW: WorkflowDefinition
  export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[]
  export function getBuiltinWorkflow(id: string): WorkflowDefinition | undefined
  ```

### `src/main/harness/dag/workflowLoader.ts`
- Exports:
  ```ts
  export interface ListWorkflowsOptions {
    includeBuiltin?: boolean
  }
  export async function listWorkflows(directory: string, options?: ListWorkflowsOptions): Promise<WorkflowDefinition[]>
  export async function loadWorkflow(directory: string, filenameOrId: string): Promise<WorkflowDefinition>
  export async function seedBuiltinWorkflows(directory: string): Promise<string[]>
  ```

## Code Layout
- `src/main/harness/providers/opencodeBridge.ts` — new provider adapter
- `src/main/harness/providers/registry.ts` — provider registration
- `src/main/harness/profiles.ts` — agent profile additions
- `src/main/providerCatalog.ts` — provider catalog additions
- `src/renderer/src/components/HarnessPanel.tsx` — provider UI options
- `src/main/harness/dag/builtinWorkflows.ts` — new built-in workflow definitions
- `.opencode/workflows/code-review-fix.json` — new workflow template file
- `.opencode/workflows/feature-implementation.json` — new workflow template file
- `src/main/harness/dag/workflowLoader.ts` — loader enhancement
- `src/main/ipc.ts` — IPC loader fallback
- `src/main/__tests__/harnessOpencodeBridge.test.ts` — bridge unit tests
- `src/main/__tests__/harnessOpencodeBridge.adversarial.test.ts` — bridge adversarial tests
- `src/main/__tests__/dagBuiltinTemplates.test.ts` — template validation tests
- `src/main/__tests__/dagWorkflowLoader.test.ts` — loader tests
- `src/main/__tests__/dagEmpiricalChallenger2.test.ts` — dag challenger tests
