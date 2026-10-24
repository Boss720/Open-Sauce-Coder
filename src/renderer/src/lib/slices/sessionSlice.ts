/**
 * Server status, the working directory, sessions, transcripts, and sending.
 *
 * `send()` is the one place a normal (non-compare) exchange is opened, so it is also where the
 * attempt machine is armed. It reaches the ledger, `lastPrompt` and `rotateRetries` through the
 * accessors in `attemptMachine.ts` — all synchronous, so the reserve-then-`set()` sequence stays a
 * single uninterrupted block exactly as before.
 */

import { isAssistant } from '../types'
import { isAgentModel } from '../models'
import { savePrefs } from '../prefs'
import { classifyError, isTokenThroughputLimit } from '../rotation'
import { isFreeModel, FREE_PROVIDER_CAPS } from '../freeTier'
import { READONLY_TOOLS } from '../toolPolicies'
import { saveLedger, record429, recordFailure, reserveAttempt, releaseAttempt, selectModel, parseModelKey, isAutoRoutingActive, describeRoutingMode } from '../routing'
import { sortMessages, sortSessions, upsertSession, makeNotice } from '../collections'
import { getMatchingCommands } from '../commands'
import { api, errText } from './api'
import {
  beginFailover,
  clearActiveAttempt,
  getActiveAttempt,
  getLedger,
  resetRotateRetries,
  setLastPrompt,
  setLastSendStartTime,
  setLedger,
  startActiveAttempt
} from './attemptMachine'
import { rehydrateSessionImages, runImageCommand } from './imagesSlice'
import type { AppState, SetState, GetState } from './types'
import type { MessageWithParts, PromptPart } from '../types'

/**
 * Memoized cache for harnessPromptFields. Holds the last computed result
 * along with the sessionID and state values that produced it.
 */
let harnessPromptCache: {
  sessionID: string
  agent: string | undefined
  readOnly: boolean
  result: { agent?: string; tools?: Record<string, boolean> }
} | null = null

/**
 * Harness fields for a prompt into `sessionID`: the pinned agent (when any) and the
 * read-only tool policy (when toggled on). Both are omitted entirely when unset so the
 * prompt body — and the server's default behaviour — is untouched.
 *
 * Memoized to avoid recomputation on every send. The cache is keyed on the actual
 * state values (sessionID, sessionAgents[sessionID], sessionReadOnly[sessionID]) rather
 * than the function inputs, since the function is pure with respect to these values.
 */
export function harnessPromptFields(
  get: GetState,
  sessionID: string
): { agent?: string; tools?: Record<string, boolean> } {
  const agent = get().sessionAgents?.[sessionID]
  const readOnly = get().sessionReadOnly?.[sessionID] === true

  // Return cached result if sessionID and state values haven't changed
  if (
    harnessPromptCache &&
    harnessPromptCache.sessionID === sessionID &&
    harnessPromptCache.agent === agent &&
    harnessPromptCache.readOnly === readOnly
  ) {
    return harnessPromptCache.result
  }

  // Compute new result and update cache
  const result = {
    ...(agent ? { agent } : {}),
    ...(readOnly ? { tools: { ...READONLY_TOOLS } } : {})
  }

  harnessPromptCache = { sessionID, agent, readOnly, result }
  return result
}

export type SessionSlice = Pick<
  AppState,
  | 'server'
  | 'directory'
  | 'sessions'
  | 'activeSessionID'
  | 'messages'
  | 'busy'
  | 'todos'
  | 'branch'
  | 'queuedPrompts'
  | 'serverCommands'
  | 'pickDirectory'
  | 'setDirectory'
  | 'newSession'
  | 'selectSession'
  | 'deleteSession'
  | 'renameSession'
  | 'addSystemNotice'
  | 'queuePrompt'
  | 'removeQueued'
  | 'retryExchange'
  | 'editAndResend'
  | 'unrevertSession'
  | 'branchFromMessage'
  | 'executeSlashCommand'
  | 'send'
  | 'abort'
>

export function createSessionSlice(set: SetState, get: GetState): SessionSlice {
  return {
    server: { running: false, url: null, streamConnected: false },
    directory: null,
    sessions: [],
    activeSessionID: null,
    messages: [],
    busy: false,
    todos: [],
    branch: null,
    queuedPrompts: [],
    serverCommands: [],

    async pickDirectory(): Promise<void> {
      try {
        const dir = await api().pickDirectory()
        if (!dir) return
        await get().setDirectory(dir)
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async setDirectory(dir: string): Promise<void> {
      get().clearSubagents()
      set({
        directory: dir,
        sessions: [],
        activeSessionID: null,
        messages: [],
        permissions: [],
        busy: false,
        // Harness state belongs to the previous directory's sessions.
        agents: [],
        sessionAgents: {},
        sessionReadOnly: {}
      })
      const { providerID, modelID, modelPool, routingMode } = get()
      savePrefs({ directory: dir, providerID, modelID, theme: get().theme, modelPool, routingMode })

      try {
        const sessions = await api().sessions.list(dir)
        if (get().directory !== dir) return
        set({ sessions: sortSessions(sessions ?? []) })
      } catch (e) {
        set({ error: errText(e) })
      }
      try {
        const vcsInfo = await api().vcs.get(dir)
        set({ branch: vcsInfo?.branch ?? null })
      } catch {
        set({ branch: null })
      }
      try {
        const commands = await api().commands.list(dir)
        set({ serverCommands: commands ?? [] })
      } catch {
        set({ serverCommands: [] })
      }
      await get().loadAgents(dir)
    },

    async newSession(): Promise<void> {
      const directory = get().directory
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }
      try {
        const session = await api().sessions.create(directory)
        // A fresh session has no children — stale tabs from the previous one must not linger.
        get().clearSubagents()
        set((state) => ({
          sessions: upsertSession(state.sessions, session),
          activeSessionID: session.id,
          messages: [],
          permissions: [],
          busy: false,
          error: null
        }))
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async selectSession(id: string): Promise<void> {
      const directory = get().directory
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }
      get().clearSubagents()
      set({ activeSessionID: id, messages: [], permissions: [], busy: false })

      try {
        const loaded = await api().messages(directory, id)
        if (get().activeSessionID !== id) return
        const messages = sortMessages(loaded ?? [])
        const last = messages.length > 0 ? messages[messages.length - 1] : undefined
        const info = last?.info
        const stillRunning =
          info !== undefined &&
          isAssistant(info) &&
          info.time.completed === undefined &&
          info.error === undefined
        set({ messages, busy: stillRunning })
      } catch (e) {
        set({ error: errText(e) })
      }
      try {
        const todos = await api().sessions.todos(directory, id)
        if (get().activeSessionID === id) set({ todos: todos ?? [] })
      } catch {
        // Todos are optional
      }
      // Generated images are local-only synthetic messages, so the server transcript above does not
      // contain them. Restore them from the on-disk gallery index.
      await rehydrateSessionImages(id, get, set)
    },

    async deleteSession(id: string): Promise<void> {
      const directory = get().directory
      if (!directory) return
      try {
        await api().sessions.remove(directory, id)
        set((state) => {
          const wasActive = state.activeSessionID === id
          return {
            sessions: state.sessions.filter((s) => s.id !== id),
            activeSessionID: wasActive ? null : state.activeSessionID,
            messages: wasActive ? [] : state.messages,
            permissions: wasActive
              ? []
              : state.permissions.filter((p) => p.sessionID !== id),
            busy: wasActive ? false : state.busy
          }
        })
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    addSystemNotice(text: string): void {
      const activeSessionID = get().activeSessionID ?? 'default'
      set((state) => ({ messages: sortMessages([...state.messages, makeNotice(activeSessionID, text)]) }))
    },

    async renameSession(id: string, title: string): Promise<void> {
      const directory = get().directory
      if (!directory) return
      try {
        const updated = await api().sessions.update(directory, id, title)
        set((state) => ({ sessions: upsertSession(state.sessions, updated) }))
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    queuePrompt(text: string, parts?: PromptPart[]): void {
      set((state) => ({ queuedPrompts: [...state.queuedPrompts, { text, parts }] }))
    },

    removeQueued(index: number): void {
      set((state) => ({
        queuedPrompts: state.queuedPrompts.filter((_, i) => i !== index)
      }))
    },

    async retryExchange(
      messageID: string,
      override?: { providerID: string; modelID: string }
    ): Promise<void> {
      const { directory, activeSessionID, providerID, modelID, messages } = get()
      // One-shot override for this resend only — never touches the store's providerID/
      // modelID, setModel, prefs, routingMode, or the pinned model. Falls back to the
      // current store selection when omitted, exactly as before.
      const sendProviderID = override?.providerID ?? providerID
      const sendModelID = override?.modelID ?? modelID
      if (!directory || !activeSessionID || !sendProviderID || !sendModelID) return
      const msgIndex = messages.findIndex((m) => m.info.id === messageID)
      if (msgIndex < 0) return
      let userText: string | null = null
      for (let i = msgIndex - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info.role === 'user') {
          const textParts = m.parts.filter((p) => p.type === 'text')
          userText = textParts.map((p) => (p as { text: string }).text).join('\n').trim()
          break
        }
      }
      if (!userText) return
      set({ busy: true, error: null })
      try {
        await api().prompt({
          directory,
          sessionID: activeSessionID,
          providerID: sendProviderID,
          modelID: sendModelID,
          text: userText,
          ...harnessPromptFields(get, activeSessionID)
        })
      } catch (e) {
        set({ busy: false, error: errText(e) })
      }
    },

    async editAndResend(messageID: string, newText: string): Promise<void> {
      const { directory, activeSessionID, messages } = get()
      if (!directory || !activeSessionID) return
      if (newText.trim().length === 0) return

      const msgIndex = messages.findIndex((m) => m.info.id === messageID)
      if (msgIndex < 0) return
      if (messages[msgIndex].info.role !== 'user') return

      try {
        // Revert the server to before the edited user message. This also restores
        // workspace file snapshots — expected behaviour for edit-and-resend.
        await api().revertMessage({ directory, sessionID: activeSessionID, messageID })
        // Optimistically drop the edited message and everything after it.
        set({ messages: messages.slice(0, msgIndex) })
        // Reuse send() so routing / rotation / queueing all apply.
        await get().send(newText)
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async unrevertSession(): Promise<void> {
      const { directory, activeSessionID } = get()
      if (!directory || !activeSessionID) return
      try {
        const session = await api().unrevertMessage({ directory, sessionID: activeSessionID })
        // The response is the session with `revert` cleared — upsert it directly so the
        // reverted banner does not depend on a session.updated SSE event arriving.
        if (session) set((state) => ({ sessions: upsertSession(state.sessions, session) }))
        // The restored messages are back in the server transcript; reload to show them.
        await get().selectSession(activeSessionID)
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async branchFromMessage(messageID: string): Promise<void> {
      const { directory, activeSessionID } = get()
      if (!directory || !activeSessionID) return
      try {
        // Non-destructive: the SDK's native fork creates a brand-new session; the
        // source session and its messages are left completely untouched.
        const session = await api().forkSession({ directory, sessionID: activeSessionID, messageID })
        set((state) => ({ sessions: upsertSession(state.sessions, session) }))
        await get().selectSession(session.id)
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async executeSlashCommand(cmdText: string): Promise<void> {
      const parts = cmdText.trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const directory = get().directory

      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }

      let sessionID = get().activeSessionID
      if (!sessionID) {
        try {
          const session = await api().sessions.create(directory)
          sessionID = session.id
          set((state) => ({
            sessions: upsertSession(state.sessions, session),
            activeSessionID: session.id,
            messages: [],
            permissions: []
          }))
        } catch (e) {
          set({ error: errText(e) })
          return
        }
      }

      const usrId = `usr-${Date.now()}`
      const userMsg: MessageWithParts = {
        info: {
          id: usrId,
          sessionID: sessionID!,
          role: 'user',
          time: { created: Math.floor(Date.now() / 1000) },
          agent: get().sessionAgents[sessionID!] ?? 'default',
          model: { providerID: get().providerID ?? '', modelID: get().modelID ?? '' }
        },
        parts: [
          {
            id: `part-${usrId}`,
            messageID: usrId,
            sessionID: sessionID!,
            type: 'text',
            text: cmdText
          }
        ]
      }
      set((state) => ({ messages: sortMessages([...state.messages, userMsg]) }))

      const allMatching = getMatchingCommands(command, get().serverCommands)
      const exactMatch = allMatching.find((c) => c.name === command || c.alias === command)

      if (exactMatch && exactMatch.action) {
        const args = cmdText.slice(parts[0].length).trim()
        await exactMatch.action(args)
        return
      }

      if (command === '/help') {
        const helpText = `### 🤖 Claude Code Style Slash Commands

| Command | Description |
|---|---|
| \`/help\` | Show available slash commands and usage guide |
| \`/free\` or \`/auto\` | Toggle Free Model Auto-Routing (auto-cycles models on 429 rate limits) |
| \`/clear\` | Clear current conversation messages |
| \`/models\` | List available AI models and active provider status |
| \`/doctor\` | Run environment and OpenCode server diagnostics |
| \`/compact\` | Compact conversation context |
| \`/init\` | Create a default \`opencode.json\` config file in project folder |
| \`/cost\` | Display session message statistics and provider metrics |
| \`/image <prompt>\` | Generate an image with NanoGPT (alias \`/img\`) |
| \`/btw <question>\` | Ask a tangent in a side-chat tab, leaving this conversation untouched |`
        get().addSystemNotice(helpText)
      } else if (command === '/clear') {
        const sid = get().activeSessionID
        set({ messages: [] })
        get().addSystemNotice(
          sid
            ? `🧹 Cleared local view (server session \`${sid}\` intact). Start a new session for a fresh context.`
            : '🧹 Cleared local view. Start a new session for a fresh context.'
        )
      } else if (command === '/models') {
        const { providers, providerID, modelID, routingMode } = get()
        let text = `### 🧠 Models & Providers\n\n**Active Model:** \`${providerID}/${modelID}\`\n**Free Auto-Routing:** ${isAutoRoutingActive(routingMode) ? '⚡ ENABLED' : '⚪ DISABLED'}\n**Routing Mode:** ${describeRoutingMode(routingMode)}\n\n`
        if (providers.length === 0) {
          text += '_No providers currently connected._'
        } else {
          text += '#### Authenticated Providers:\n'
          for (const p of providers) {
            const count = Object.values(p.models ?? {}).filter(isAgentModel).length
            text += `- **${p.name}** (\`${p.id}\`): ${count} agent models available\n`
          }
        }
        get().addSystemNotice(text)
      } else if (command === '/free' || command === '/auto') {
        get().toggleAutoRotate()
        const nextMode = get().routingMode
        get().addSystemNotice(
          isAutoRoutingActive(nextMode)
            ? `⚡ **Free Model Auto-Routing is now ENABLED.** OpenCode Desktop will automatically cycle between available NanoGPT and Gemini models whenever a 429 rate limit or quota error occurs!\n\nMode: ${describeRoutingMode(nextMode)}`
            : `⚪ **Free Model Auto-Routing is now DISABLED.** ${describeRoutingMode(nextMode)}`
        )
      } else if (command === '/btw') {
        // Ask a tangent in a child session so the main transcript — and the main session's
        // single in-flight exchange slot — stay untouched. The answer streams into its own
        // tab via the existing subagent event path.
        const question = cmdText.slice(parts[0].length).trim()
        if (question.length === 0) {
          get().addSystemNotice(
            'Usage: `/btw <question>` — asks a one-off question in a side chat tab, without adding it to this conversation.'
          )
        } else {
          await get().startSideChat(question)
        }
      } else if (command === '/image' || command === '/img') {
        await runImageCommand(cmdText.slice(parts[0].length).trim(), sessionID!, set, get)
      } else if (command === '/doctor') {
        const { server, directory, providers, providerID, modelID, routingMode } = get()
        const text = `### 🩺 System Diagnostics

- **OpenCode Server Status:** ${server.running ? '✅ Running' : '❌ Offline'} (${server.url ?? 'N/A'})
- **Project Directory:** \`${directory ?? 'None'}\`
- **Active Model:** \`${providerID ?? 'None'} / ${modelID ?? 'None'}\`
- **Connected Providers:** ${providers.length} (${providers.map((p) => p.name).join(', ') || 'None'})
- **Free Model Auto-Routing:** ${isAutoRoutingActive(routingMode) ? '⚡ Enabled' : 'Disabled'}
- **Routing Mode:** ${describeRoutingMode(routingMode)}
- **Platform:** Windows`
        get().addSystemNotice(text)
      } else {
        get().addSystemNotice(`Unknown slash command: \`${command}\`. Type \`/help\` for a list of available commands.`)
      }
    },

    async send(text: string, parts?: PromptPart[]): Promise<void> {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      if (trimmed.startsWith('/')) {
        await get().executeSlashCommand(trimmed)
        return
      }

      const { directory, routingMode, modelPool, providers, linkedProviderIDs } = get()
      let { providerID, modelID } = get()

      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }

      // Legacy 'auto' mode: keep the proactive pre-send hijack for power users.
      // 'failover' (default) and 'locked' modes never pre-swap the user's pick.
      if (routingMode === 'auto' && providers.length > 0) {
        const available = new Set<string>()
        for (const p of providers) {
          if (!linkedProviderIDs.includes(p.id)) continue
          for (const m of Object.values(p.models ?? {})) {
            if (isAgentModel(m) && isFreeModel(p.id, m.id)) available.add(`${p.id}/${m.id}`)
          }
        }

        const currentKey = providerID && modelID ? `${providerID}/${modelID}` : null
        const chosenKey = selectModel(modelPool, getLedger(), FREE_PROVIDER_CAPS, Date.now(), {
          sticky: false,
          current: currentKey,
          available,
          authenticatedProviders: new Set(linkedProviderIDs)
        })

        if (chosenKey && chosenKey !== currentKey) {
          const parsed = parseModelKey(chosenKey)
          if (parsed) {
            providerID = parsed.providerID
            modelID = parsed.modelID
            set({ providerID, modelID })
            // Effective-only rotation: do NOT savePrefs — user's chosen pin stays intact.
            const pName = providers.find((p) => p.id === providerID)?.name ?? providerID
            const mName = providers.find((p) => p.id === providerID)?.models?.[modelID]?.name ?? modelID
            get().addSystemNotice(`⚡ **Auto-mode: proactively selected ${pName} · ${mName}**`)
          }
        }
      }

      if (!providerID || !modelID) {
        set({ error: 'Choose a model before sending a message.' })
        return
      }
      if (!linkedProviderIDs.includes(providerID)) {
        set({ error: `Add an API key for ${providerID} before routing a request to it.` })
        return
      }

      let sessionID = get().activeSessionID
      if (!sessionID) {
        try {
          const session = await api().sessions.create(directory)
          sessionID = session.id
          set((state) => ({
            sessions: upsertSession(state.sessions, session),
            activeSessionID: session.id,
            messages: [],
            permissions: []
          }))
        } catch (e) {
          set({ busy: false, error: errText(e) })
          return
        }
      }

      const policy = harnessPromptFields(get, sessionID)
      const hasPolicy = Boolean(policy && Object.keys(policy).length > 0)
      setLastPrompt({
        text: trimmed,
        parts,
        sessionID,
        userMessageID: null,
        ...(hasPolicy ? { policy } : {})
      })
      resetRotateRetries()
      const sendStartTime = Date.now()
      setLastSendStartTime(sendStartTime)
      setLedger(reserveAttempt(getLedger(), `${providerID}/${modelID}`, sendStartTime))
      saveLedger(getLedger())
      startActiveAttempt(sessionID, providerID, modelID)
      set({ busy: true, error: null })

      try {
        await api().prompt({
          directory,
          sessionID,
          providerID,
          modelID,
          text: trimmed,
          parts,
          ...policy
        })
      } catch (e) {
        const attempt = getActiveAttempt()
        const attemptSafe = !attempt?.toolExecuted && !attempt?.hasStreamed
        clearActiveAttempt(sessionID)
        const errString = errText(e)
        const now = Date.now()
        const errClass = classifyError(errString)
        const failedProviderID = isTokenThroughputLimit(errString) ? providerID : undefined
        if (providerID && modelID) {
          if (errClass === 'rpm-wait' || errClass === 'rpd-drop') {
            setLedger(record429(getLedger(), `${providerID}/${modelID}`, now, undefined, {
              daily: errClass === 'rpd-drop',
              caps: FREE_PROVIDER_CAPS
            }))
          } else {
            setLedger(recordFailure(getLedger(), `${providerID}/${modelID}`, now))
          }
          // Release the reservation — dispatch failed before the request landed
          setLedger(releaseAttempt(getLedger(), `${providerID}/${modelID}`))
          saveLedger(getLedger())
        }

        const canFailover =
          get().routingMode !== 'locked' &&
          (errClass === 'rpm-wait' || errClass === 'rpd-drop' || errClass === 'tpm-drop' || errClass === 'timeout' || errClass === 'transient')

        // R1 guard: if any tool ran or tokens streamed, do NOT auto-retry


        if (canFailover && attemptSafe) {
          const failoverResult = await beginFailover(
            sessionID,
            directory,
            trimmed,
            parts,
            `Rate limit / error on ${providerID}/${modelID}`,
            `${providerID}/${modelID}`,
            failedProviderID,
            ...(hasPolicy ? [policy] : [])
          )
          if (failoverResult) return
        }
        set({ busy: false, error: errString })
      }
    },

    async abort(): Promise<void> {
      const { directory, activeSessionID } = get()
      if (!directory || !activeSessionID) return
      try {
        clearActiveAttempt(activeSessionID)
        await api().abort(directory, activeSessionID)
        set({ busy: false })
      } catch (e) {
        set({ busy: false, error: errText(e) })
      }
    }
  }
}
