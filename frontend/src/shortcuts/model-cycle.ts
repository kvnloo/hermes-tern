// Relative model cycling uses the existing picker/switchModel confirmation contract.
// Model inventory and pending model intent come from the gateway, never this pane.

import type { ModelOptionsResult } from '@hermes/shared/gateway-events'

import type { ModelsHost } from '../overlays/models.js'
import { pickerValue, switchModel } from '../overlays/models.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { rpc } from '../wire/rpc.js'

import { modelId, modelRecents, type RecentModel } from './model-recents.js'

/** Authenticated and available rows only, in the gateway's picker order. */
export function availableModels(options: Pick<ModelOptionsResult, 'providers'>): RecentModel[] {
  const rows = (options.providers ?? [])
    .filter(provider => provider.authenticated !== false)
    .flatMap(provider => (provider.models ?? [])
      .filter(model => !provider.unavailable_models?.includes(model))
      .map(model => ({ model, provider: provider.slug })))

  return [...new Map(rows.map(row => [modelId(row), row])).values()]
}

/** The pending route wins during a streaming turn; otherwise use the confirmed gateway route. */
export function activeModel(options: ModelOptionsResult, fallback: RecentModel): RecentModel {
  const currentProvider = options.providers?.find(provider => provider.is_current)?.slug || options.provider || fallback.provider

  return {
    model: options.pending_model || options.model || fallback.model,
    provider: options.pending_model ? options.pending_provider || currentProvider : currentProvider
  }
}

/** Choose from recent selections, or from the full authorized picker inventory. */
export function cycleTarget(
  available: readonly RecentModel[],
  recent: readonly RecentModel[],
  active: RecentModel,
  direction: -1 | 1
): RecentModel | null {
  const allowed = new Set(available.map(modelId))
  const seen = new Set<string>()
  const valid = (recent.length > 1 ? recent : available)
    .filter(row => allowed.has(modelId(row)))
    .filter(row => {
      const id = modelId(row)

      if (seen.has(id)) {
        return false
      }

      seen.add(id)

      return true
    })
  const rows = [...valid]

  if (active.model && !seen.has(modelId(active))) {
    rows.unshift(active)
  }

  if (rows.length < 2) {
    return null
  }

  const at = rows.findIndex(row => modelId(row) === modelId(active))

  return rows[(at + direction + rows.length) % rows.length] ?? null
}

export function cycleModel(host: ModelsHost, direction: -1 | 1): Promise<void> {
  const sid = host.session.ref.live
  const history = modelRecents(host.session)

  return history.enqueue(async () => {
    if (!sid || host.session.ref.live !== sid) {
      return
    }

    const current = () => host.session.ref.live === sid

    try {
      const options = await rpc(host.gw, 'model.options', { safe_inventory: true, session_id: sid })

      if (!current()) {
        return
      }

      const active = activeModel(options, {
        model: host.session.info?.model ?? '',
        provider: host.session.info?.provider ?? ''
      })
      const available = availableModels(options)
      const next = cycleTarget(available, history.list(sid), active, direction)

      if (!next) {
        host.transcript.notice('Only one model is available to cycle. Use /model to choose another.')
        host.changed()

        return
      }

      const value = pickerValue(next.model, next.provider, false)
      const result = await switchModel(host, value)

      if (!current()) {
        return
      }

      if (result.confirm_required) {
        host.open(confirmOverlay(host, {
          title: 'Switch to an expensive model?',
          detail: result.confirm_message || result.warning || next.model,
          confirm: 'Switch anyway',
          onConfirm: () => {
            if (!current()) {
              return
            }

            void switchModel(host, value, true).catch(error => {
              if (current()) {
                host.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
                host.changed()
              }
            })
          }
        }))
      }
    } catch (error) {
      if (current()) {
        host.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
        host.changed()
      }
    }
  })
}
