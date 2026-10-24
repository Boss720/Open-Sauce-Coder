/**
 * The single renderer store (zustand).
 *
 * Components read via selectors and never keep their own copy of server state.
 * All traffic goes through `window.api` (the preload bridge) — the renderer never
 * speaks HTTP and never imports SDK runtime code.
 *
 * This file is now only the COMPOSITION ROOT. The state itself lives in domain slices
 * under `./slices/`:
 *
 *   sessionSlice   server status, directory, sessions, messages, busy, queue, send/abort
 *   routingSlice   providers, chosen/effective model split, rotation
 *   compareSlice   the multi-model fan-out and its own SSE path
 *   subagentSlice  Task-tool child session tabs and their own SSE path
 *   agentSlice     agent registry, per-session agent picker + read-only toggle
 *   harnessSlice   agentic-harness profiles, runs, and the `oc:harness:event` stream
 *   projectsSlice  projects, app settings, updater status
 *   uiSlice        theme, active view, permissions, error banner, artifact panel
 *   eventSlice     `applyEvent`, the one SSE reducer, composed over all of the above
 *   imagesSlice    `/image` generation and gallery rehydration (helpers; holds no state)
 *   attemptMachine the SINGLETON failover state: watchdogs, ledger, `beginFailover`
 *
 * `init()` and `subscribe()` stay here because they are bootstrap, not domain: they
 * orchestrate every slice in a fixed order.
 */

import { create } from 'zustand'
import { loadPrefs, savePrefs } from './prefs'
import { pickDefaultModel, restoredSelectionValid } from './rotation'
import { api, errText } from './slices/api'
import { restoreLedger } from './slices/attemptMachine'
import { createAgentSlice } from './slices/agentSlice'
import { createCompareSlice } from './slices/compareSlice'
import { createEditorSlice } from './slices/editorSlice'
import { createEventSlice } from './slices/eventSlice'
import { createFileTreeSlice } from './slices/fileTreeSlice'
import { createGitSlice } from './slices/gitSlice'
import { createHarnessSlice } from './slices/harnessSlice'
import { createDagSlice } from './slices/dagSlice'
import { createProjectsSlice } from './slices/projectsSlice'
import { createRoutingSlice } from './slices/routingSlice'
import { createSessionSlice } from './slices/sessionSlice'
import { createSubagentSlice } from './slices/subagentSlice'
import { createTerminalSlice } from './slices/terminalSlice'
import { createUiSlice } from './slices/uiSlice'
import { createNanoQuotaSlice, startNanoQuotaPolling } from './slices/nanoQuotaSlice'
import { registerStore } from './slices/storeRef'
import type { AppState, SetState, GetState } from './slices/types'
import type { Provider } from './types'

export type { AppState }
export { errText }

export const useStore = create<AppState>()((set, get) => {
  const setState = set as SetState
  const getState = get as GetState

  return {
    ...createSessionSlice(setState, getState),
    ...createRoutingSlice(setState, getState),
    ...createCompareSlice(setState, getState),
    ...createSubagentSlice(setState, getState),
    ...createAgentSlice(setState, getState),
    ...createProjectsSlice(setState, getState),
    ...createUiSlice(setState, getState),
    ...createFileTreeSlice(setState, getState),
    ...createEditorSlice(setState, getState),
    ...createGitSlice(setState, getState),
    ...createTerminalSlice(setState, getState),
    ...createEventSlice(setState, getState),
    ...createNanoQuotaSlice(setState, getState),
    ...createHarnessSlice(setState, getState),
    ...createDagSlice(setState, getState),

    async init(): Promise<void> {
      subscribe()
      restoreLedger()
      const appSettingsReady = get().loadAppSettings()

      try {
        const status = await api().status()
        set({ server: status })
      } catch (e) {
        set({ server: { running: false, url: null, streamConnected: false, error: errText(e) } })
      }

      // The main process may still be spawning `opencode serve`. Poll status
      // briefly instead of blowing up on providers() before the server is ready;
      // the `onServer` bridge will also refetch once the status flips.
      for (let i = 0; i < 40 && !get().server.running; i++) {
        await new Promise((r) => setTimeout(r, 250))
      }

      let providers: Provider[] = []
      let defaultModels: Record<string, string> = {}
      let linkedProviderIDs: string[] = []
      if (get().server.running) {
        try {
          const result = await api().providers()
          providers = result?.providers ?? []
          defaultModels = result?.default ?? {}
          linkedProviderIDs = result?.linkedProviderIDs ?? []
          set({ providers, defaultModels, linkedProviderIDs })
        } catch (e) {
          set({ error: errText(e) })
        }
      }

      const prefs = loadPrefs()
      let providerID = prefs.providerID
      let modelID = prefs.modelID

      // Only re-pick when we actually know what the server offers; otherwise keep
      // whatever the user last chose so a temporarily-down server does not reset it.
      // A restored selection that no longer exists, or no longer passes the
      // agent-model predicate, falls through to the default preference walk.
      const linkedProviders = providers.filter((provider) => linkedProviderIDs.includes(provider.id))
      if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID, prefs.showPaidModels)) {
        const picked = pickDefaultModel(linkedProviders)
        providerID = picked ? picked.providerID : null
        modelID = picked ? picked.modelID : null
      }

      set({
        providerID,
        modelID,
        pinnedProviderID: providerID,
        pinnedModelID: modelID,
        theme: prefs.theme,
        modelPool: prefs.modelPool,
        routingMode: prefs.routingMode,
        showPaidModels: prefs.showPaidModels,
        compareTargets: prefs.compareTargets,
        viewMode: prefs.viewMode,
        showBalanceInStatus: prefs.showBalanceInStatus,
      })
      savePrefs({
        directory: prefs.directory,
        providerID,
        modelID,
        theme: prefs.theme,
        modelPool: prefs.modelPool,
        routingMode: prefs.routingMode,
        showPaidModels: prefs.showPaidModels,
        viewMode: prefs.viewMode,
        showBalanceInStatus: prefs.showBalanceInStatus,
      })

      await appSettingsReady
      await get().loadProjects()
      startNanoQuotaPolling(getState)

      if (prefs.directory) {
        await get().setDirectory(prefs.directory)
      }
    }
  }
})

// Bind the late-bound handle the attempt machine's watchdog timers use. This runs at module
// evaluation, before any action or timer can fire.
registerStore({
  getState: () => useStore.getState(),
  setState: (partial) => useStore.setState(partial)
})

/* ------------------------------------------------------------------ *
 * Bridge subscriptions — wired exactly once
 * ------------------------------------------------------------------ */

let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  try {
    const bridge = api()
    bridge.onEvent((event) => {
      useStore.getState().applyEvent(event)
    })
    bridge.harness.onEvent((payload) => {
      useStore.getState().handleHarnessEvent(payload)
    })
    bridge.dag?.onEvent?.((event) => {
      useStore.getState().handleDagEvent(event)
    })
    bridge.onServer((status) => {
      const prev = useStore.getState().server
      useStore.setState({ server: status })
      // Server went down — clear providers so they get refetched on reconnect.
      if (!status.running && prev.running) {
        useStore.setState({ providers: [], defaultModels: {}, linkedProviderIDs: [] })
      }
      // Server just came up (or came back) — refetch providers.
      if (status.running && !prev.running) {
        void (async () => {
          try {
            const result = await bridge.providers()
            useStore.setState({
              providers: result?.providers ?? [],
              defaultModels: result?.default ?? {},
              linkedProviderIDs: result?.linkedProviderIDs ?? []
            })
            const { providerID, modelID, providers, linkedProviderIDs } = useStore.getState()
            const linkedProviders = providers.filter((provider) => linkedProviderIDs.includes(provider.id))
            const showPaid = useStore.getState().showPaidModels
            if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID, showPaid)) {
              const picked = pickDefaultModel(linkedProviders)
              const nextProvider = picked ? picked.providerID : null
              const nextModel = picked ? picked.modelID : null
              useStore.setState({ providerID: nextProvider, modelID: nextModel })
              savePrefs({
                directory: useStore.getState().directory,
                providerID: nextProvider,
                modelID: nextModel,
                theme: useStore.getState().theme,
                modelPool: useStore.getState().modelPool,
                routingMode: useStore.getState().routingMode,
                showPaidModels: useStore.getState().showPaidModels,
              })
            }
          } catch (e) {
            useStore.setState({ error: errText(e) })
          }
        })()
      }
    })
    bridge.onUpdateStatus((status) => {
      useStore.getState().setUpdateStatus(status)
    })
  } catch (e) {
    subscribed = false
    useStore.setState({ error: errText(e) })
  }
}
