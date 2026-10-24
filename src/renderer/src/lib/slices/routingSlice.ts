/**
 * Providers, model selection, and the chosen/effective split.
 *
 * The routing LEDGER and the failover machinery itself live in `attemptMachine.ts` — they are
 * singletons shared with `send()` and the SSE reducer, and duplicating them here would let a
 * proactive pick race a reactive retry against a stale snapshot. This slice only reads the
 * ledger through the accessor when picking a model.
 */

import { isAgentModel } from '../models'
import { savePrefs, type RoutingMode } from '../prefs'
import { isFreeModel } from '../freeTier'
import { selectModel, parseModelKey } from '../routing'
import { FREE_PROVIDER_CAPS } from '../freeTier'
import { getLedger } from './attemptMachine'
import type { AppState, SetState, GetState } from './types'

export type RoutingSlice = Pick<
  AppState,
  | 'providers'
  | 'defaultModels'
  | 'linkedProviderIDs'
  | 'providerID'
  | 'modelID'
  | 'pinnedProviderID'
  | 'pinnedModelID'
  | 'modelPool'
  | 'routingMode'
  | 'showPaidModels'
  | 'setModel'
  | 'revertToPinned'
  | 'toggleAutoRotate'
  | 'setRoutingMode'
  | 'setShowPaidModels'
  | 'setModelPool'
  | 'rotateToNextFreeModel'
>

export function createRoutingSlice(set: SetState, get: GetState): RoutingSlice {
  return {
    providers: [],
    defaultModels: {},
    linkedProviderIDs: [],
    providerID: null,
    modelID: null,
    pinnedProviderID: null,
    pinnedModelID: null,
    modelPool: null,
    routingMode: 'failover' as RoutingMode,
    showPaidModels: false,

    /**
     * Toggles auto model-switching. This drives `routingMode` directly — the only value any
     * failover gate reads. It previously flipped a separate `autoRotate` boolean that no gate
     * consulted and that `savePrefs` immediately overwrote, so the badge could read "on" while
     * `locked` suppressed every failover.
     *
     * Off maps to `locked`. On maps to `failover` rather than `auto`, because `failover` is what
     * the UI copy has always described ("cycles models on 429") and it never overwrites the
     * user's pinned pick; `auto` remains reachable from the Settings radio.
     */
    toggleAutoRotate(): void {
      const mode: RoutingMode = get().routingMode === 'locked' ? 'failover' : 'locked'
      get().setRoutingMode(mode)
    },

    setRoutingMode(mode: RoutingMode): void {
      set({ routingMode: mode })
      const { directory, providerID, modelID, theme, modelPool, showPaidModels } = get()
      savePrefs({ directory, providerID, modelID, theme, modelPool, routingMode: mode, showPaidModels })
    },

    setShowPaidModels(v: boolean): void {
      set({ showPaidModels: v })
      const { directory, providerID, modelID, theme, modelPool, routingMode } = get()
      savePrefs({ directory, providerID, modelID, theme, modelPool, routingMode, showPaidModels: v })
    },

    setModelPool(pool: string[] | null): void {
      set({ modelPool: pool })
      const { directory, providerID, modelID, theme, routingMode } = get()
      savePrefs({ directory, providerID, modelID, theme, modelPool: pool, routingMode })
    },

    rotateToNextFreeModel(exclude?: string, excludeProviderID?: string): { providerID: string; modelID: string; providerName: string; modelName: string } | null {
      const { providers, linkedProviderIDs, providerID: currentP, modelID: currentM, modelPool } = get()
      if (providers.length === 0) return null

      // Free-only pool for auto-failover (never routes to paid, even if showPaidModels is on)
      const available = new Set<string>()
      for (const p of providers) {
        if (!linkedProviderIDs.includes(p.id)) continue
        for (const m of Object.values(p.models ?? {})) {
          if (isAgentModel(m) && isFreeModel(p.id, m.id)) available.add(`${p.id}/${m.id}`)
        }
      }
      // A failed model must never be immediately selected again.  Transient
      // errors do not impose a long provider cooldown, so relying on the ledger
      // alone can otherwise make failover retry the same high-ranked model.
      if (exclude) available.delete(exclude)
      if (excludeProviderID) {
        for (const key of available) {
          if (parseModelKey(key)?.providerID === excludeProviderID) available.delete(key)
        }
      }

      const chosenKey = selectModel(modelPool, getLedger(), FREE_PROVIDER_CAPS, Date.now(), {
        sticky: false,
        current: currentP && currentM ? `${currentP}/${currentM}` : null,
        available,
        authenticatedProviders: new Set(linkedProviderIDs)
      })

      if (chosenKey && chosenKey !== `${currentP}/${currentM}`) {
        const parsed = parseModelKey(chosenKey)
        if (!parsed) return null
        const { providerID: nextP, modelID: nextM } = parsed
        const provider = providers.find((p) => p.id === nextP)
        const model = provider?.models?.[nextM]
        if (provider && model) {
          // R4: effective-only rotation — do NOT savePrefs; chosen pin stays intact
          set({ providerID: nextP, modelID: nextM })
          return {
            providerID: nextP,
            modelID: nextM,
            providerName: provider.name,
            modelName: model.name ?? nextM
          }
        }
      }

      return null
    },

    setModel(providerID: string, modelID: string): void {
      // Setting a model updates BOTH pinned (user intent) and effective (current run)
      set({ providerID, modelID, pinnedProviderID: providerID, pinnedModelID: modelID })
      const { directory, theme, modelPool, routingMode, showPaidModels } = get()
      savePrefs({ directory, providerID, modelID, theme, modelPool, routingMode, showPaidModels })
    },

    revertToPinned(): void {
      const { pinnedProviderID, pinnedModelID } = get()
      if (!pinnedProviderID || !pinnedModelID) return
      set({ providerID: pinnedProviderID, modelID: pinnedModelID })
    }
  }
}
