/**
 * Built-in Multi-Agent Workflow Templates.
 *
 * Provides ready-to-run declarative workflow templates for common multi-agent
 * engineering pipelines (code review & fix, feature implementation) that conform
 * to WorkflowDefinition and Kahn topological wave scheduling.
 */

import type { WorkflowDefinition } from './types'

export const CODE_REVIEW_FIX_WORKFLOW: WorkflowDefinition = {
  id: 'code-review-fix',
  name: 'Code Review -> Test Writer -> Fixer',
  description:
    'Automated 3-stage quality pipeline: thorough code review, adversarial test writing, and bug fixing.',
  version: '1.0.0',
  nodes: [
    {
      id: 'code_reviewer',
      name: 'Code Reviewer',
      profileId: 'reviewer',
      prompt:
        'You are the Code Reviewer agent.\n\nPerform a comprehensive code review of the workspace:\n1. Inspect recent changes, git history, or target files using grep, fs_list, and fs_read.\n2. Identify functional bugs, edge-case mishandling, type errors, performance bottlenecks, or security flaws.\n3. For each defect found, document:\n   - File path and approximate line numbers\n   - Description of the defect and severity (Critical, Major, Minor)\n   - Reproduction conditions or failing scenario\n   - Recommended architectural fix strategy\n4. Produce a structured review summary detailing all findings.',
      dependencies: [],
      policy: {
        abortOnFail: true
      },
      maxTurns: 15
    },
    {
      id: 'test_writer',
      name: 'Test Writer',
      profileId: 'coder',
      prompt:
        'You are the Test Writer agent.\nYour objective is to author automated tests for the issues identified in the code review.\n\nCode Review Findings:\n{{inputs.code_reviewer.output}}\n\nInstructions:\n1. Review the defect descriptions above.\n2. Inspect existing test conventions and frameworks in the repository using fs_read, fs_list, or grep.\n3. Create or update test files covering each reported defect using fs_write or fs_patch.\n4. Run the tests using the shell tool (e.g. npm test or vitest) to verify that the tests properly reproduce or assert the expected behavior.\n5. Provide a detailed summary of:\n   - New or updated test files and test case names\n   - Commands executed and their outputs\n   - Which tests currently fail (confirming the bug) or pass',
      dependencies: ['code_reviewer'],
      policy: {
        abortOnFail: true
      },
      maxTurns: 25
    },
    {
      id: 'fixer',
      name: 'Fixer',
      profileId: 'coder',
      prompt:
        'You are the Fixer agent.\nYour objective is to fix the issues identified by the Code Reviewer and ensure all tests authored by the Test Writer pass cleanly.\n\nCode Review Findings:\n{{inputs.code_reviewer.output}}\n\nTest Writer Report:\n{{inputs.test_writer.output}}\n\nInstructions:\n1. Analyze the review findings and the newly authored tests.\n2. Modify the implementation files using fs_patch or fs_write to fix each defect. Avoid unnecessary stylistic refactoring.\n3. Run the project tests and typecheck using the shell tool (e.g. npm test, npm run typecheck, npm run lint).\n4. Ensure all newly written tests and pre-existing regression test suites pass with 0 errors.\n5. Summarize all changes applied:\n   - Files modified with diff summaries\n   - Final test and typecheck execution results\n   - Confirmation of defect resolution',
      dependencies: ['code_reviewer', 'test_writer'],
      policy: {
        abortOnFail: true
      },
      maxTurns: 35
    }
  ]
}

export const FEATURE_IMPLEMENTATION_WORKFLOW: WorkflowDefinition = {
  id: 'feature-implementation',
  name: 'Architecture Planner -> Implementer -> Verifier',
  description:
    'End-to-end feature delivery pipeline: architectural planning, code implementation, and validation.',
  version: '1.0.0',
  nodes: [
    {
      id: 'architect',
      name: 'Architecture Planner',
      profileId: 'orchestrator',
      prompt:
        'You are the Architecture Planner agent.\nYour objective is to produce a comprehensive, structured technical implementation blueprint for the requested feature.\n\nInstructions:\n1. Explore the workspace using fs_read, fs_list, and grep to understand the existing project architecture, coding standards, directory conventions, and dependencies.\n2. Formulate a technical blueprint with the following sections:\n   - Architectural Overview & System Context\n   - Component/Module Breakdown (exact files to create or modify)\n   - Interface & Data Contracts (types, schemas, IPC channels, or API methods)\n   - Step-by-Step Implementation Strategy\n   - Verification & Acceptance Criteria (commands to execute, edge cases to validate)\n3. Provide the full blueprint for the Implementer and Verifier agents.',
      dependencies: [],
      policy: {
        abortOnFail: true
      },
      maxTurns: 25
    },
    {
      id: 'implementer',
      name: 'Implementer',
      profileId: 'coder',
      prompt:
        'You are the Implementer agent.\nYour objective is to implement the feature in accordance with the architectural blueprint.\n\nArchitectural Blueprint:\n{{inputs.architect.output}}\n\nInstructions:\n1. Review the architectural blueprint above carefully.\n2. Implement all required modules, functions, and interfaces using fs_write, fs_patch, and shell.\n3. Adhere to repository conventions (TypeScript strictness, error handling, formatting).\n4. Write or update unit tests covering the new functionality.\n5. Run local builds or test runs via shell tool to verify that the implementation compiles and runs.\n6. Provide a concise summary of all files created/modified and any implementation notes for the Verifier.',
      dependencies: ['architect'],
      policy: {
        abortOnFail: true
      },
      maxTurns: 40
    },
    {
      id: 'verifier',
      name: 'Verifier',
      profileId: 'coder',
      prompt:
        'You are the Verifier agent.\nYour objective is to validate that the implemented feature satisfies all architectural specifications and passes all verification gates.\n\nArchitectural Blueprint:\n{{inputs.architect.output}}\n\nImplementer Summary:\n{{inputs.implementer.output}}\n\nInstructions:\n1. Cross-reference the implemented files against the blueprint requirements.\n2. Run the repository type check command using the shell tool (e.g. npm run typecheck).\n3. Run the linter using the shell tool (e.g. npm run lint).\n4. Run the full test suite using the shell tool (e.g. npm test or vitest).\n5. Verify edge cases, error conditions, and contract alignment.\n6. Produce a final verification report:\n   - Status of typecheck, lint, and test suites\n   - Architectural compliance checklist\n   - Final sign-off: PASS or DEFECTS FOUND (with remediation guidance)',
      dependencies: ['architect', 'implementer'],
      policy: {
        abortOnFail: true
      },
      maxTurns: 20
    }
  ]
}

export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [
  CODE_REVIEW_FIX_WORKFLOW,
  FEATURE_IMPLEMENTATION_WORKFLOW
]

/**
 * Retrieves a built-in workflow template by its unique identifier.
 * Returns a defensive copy via structuredClone to protect global templates against mutation.
 */
export function getBuiltinWorkflow(id: string): WorkflowDefinition | undefined {
  const normalizedId = id.endsWith('.json') ? id.slice(0, -5) : id
  const match = BUILTIN_WORKFLOWS.find(
    (workflow) => workflow.id === id || workflow.id === normalizedId
  )
  return match ? structuredClone(match) : undefined
}
