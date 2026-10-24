/**
 * Provider adapter interface and shared types for the agentic harness.
 *
 * Every provider adapter implements this interface, normalising heterogeneous
 * LLM APIs (NanoGPT OpenAI-compat, Google Gemini, etc.) to a common shape
 * for the AgentRunner.
 */

// ── Message types ──

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

// ── Tool schema ──

export type FunctionDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// ── Request / Response ──

export type ChatRequest = {
  requestId: string
  signal?: AbortSignal
  model: string
  messages: ChatMessage[]
  tools?: FunctionDefinition[]
  temperature?: number
  maxTokens?: number
  topP?: number
  thinking?: { enabled: boolean; budget?: number }
  routingSuffix?: string
  caching?: boolean
  billingRoute?: 'subscription' | 'standard'
  baseUrl?: string
  directory?: string
}

export type ChatResponse = {
  id: string
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  usage: { input: number; output: number; reasoning?: number }
  thinkingContent?: string
}

export type ChatDelta = {
  content?: string
  toolCalls?: ToolCall[]
  thinkingContent?: string
  finishReason?: ChatResponse['finishReason']
}

// ── Adapter interface ──

export type ProviderAdapter = {
  readonly id: string

  /** Send a chat completion request with tool definitions and optional streaming delta callbacks. */
  chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse>

  /** Abort an in-flight request by its correlation id. */
  abort(requestId: string): void

  /** Health check — can this adapter reach its API right now? */
  probe(): Promise<boolean>
}
