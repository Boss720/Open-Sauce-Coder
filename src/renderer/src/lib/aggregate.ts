/**
 * Session cost and context gauge computations — pure functions, no store dependency.
 */

import { isAssistant } from './types'
import type { MessageWithParts, Provider } from './types'

/** Total USD cost across all assistant messages in a session. */
export function sessionCost(messages: MessageWithParts[]): number {
  let total = 0
  for (const m of messages) {
    if (isAssistant(m.info) && typeof m.info.cost === 'number') {
      total += m.info.cost
    }
  }
  return total
}

/** Total input + output tokens of the most recent assistant message (approximate context used). */
export function contextUsed(messages: MessageWithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (isAssistant(info) && info.tokens) {
      return info.tokens.input + info.tokens.output
    }
  }
  return 0
}

/**
 * Tokens billed by the most recent assistant message, for TPM accounting.
 *
 * Cached-read tokens are deliberately excluded: whether a provider meters them
 * against TPM varies, and the two failure modes are not symmetric. Undercounting
 * risks a 429 the router already handles gracefully; overcounting would park a
 * perfectly healthy model, which is the silent failure. So this errs low.
 *
 * Returns 0 when the newest assistant message has no token record yet.
 */
export function lastAssistantTokenTotal(messages: MessageWithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (!isAssistant(info) || !info.tokens) continue
    const { input, output, reasoning } = info.tokens
    const sum =
      (typeof input === 'number' ? input : 0) +
      (typeof output === 'number' ? output : 0) +
      (typeof reasoning === 'number' ? reasoning : 0)
    return Number.isFinite(sum) && sum > 0 ? sum : 0
  }
  return 0
}

/** Input tokens from the most recent assistant message, used for input-only TPM caps. */
export function lastAssistantInputTokenCount(messages: MessageWithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (!isAssistant(info) || !info.tokens) continue
    const input = info.tokens.input
    return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0
  }
  return 0
}

/** The model's context window limit in tokens. Returns 0 if not found. */
export function contextLimit(
  providers: Provider[],
  providerID: string | null,
  modelID: string | null
): number {
  if (!providerID || !modelID) return 0
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  return model?.limit?.context ?? 0
}
