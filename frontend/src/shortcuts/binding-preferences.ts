// The owning Hermes session's display settings are the only preference source.
// Adapted from Hermes ui-tsp/src/binding-preferences.ts; no local auth/config authority.

import type { ConfigGetResult } from '@hermes/shared/gateway-events'
import type { Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { rpc } from '../wire/rpc.js'

import { APP_SHORTCUTS, effectiveShortcuts, shortcutMatches, type Shortcut } from './actions.js'

/** config.get full is scoped to session_id by the pinned Hermes gateway. */
function displayConfig(result: ConfigGetResult): Record<string, unknown> {
  const config = result.config

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.get full did not return a config object')
  }

  const display = config['display']

  if (display === undefined || display === null) {
    return {}
  }

  if (typeof display !== 'object' || Array.isArray(display)) {
    throw new Error('display must be an object')
  }

  // Narrow the raw object to the only display keys this slice reads.
  return {
    tern_keybindings: 'tern_keybindings' in display ? display.tern_keybindings : undefined,
    tern_profile_identity: 'tern_profile_identity' in display ? display.tern_profile_identity : undefined
  }
}

function wantsProfile(result: ConfigGetResult): boolean {
  const config = result.config
  const display = config && typeof config === 'object' ? config['display'] : undefined

  return Boolean(display && typeof display === 'object' && !Array.isArray(display) && 'tern_profile_identity' in display && display.tern_profile_identity === true)
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

export interface BindingHost {
  readonly gw: Pick<GatewayClient, 'request'>
  sid(): string | null
  changed(): void
  notice(text: string): void
}

export class BindingPreferences {
  readonly #host: BindingHost
  #sid: string | null = null
  #read = 0
  #actions: readonly Shortcut[] = APP_SHORTCUTS
  #profile = ''

  constructor(host: BindingHost) {
    this.#host = host
  }

  get actions(): readonly Shortcut[] {
    return this.#host.sid() === this.#sid ? this.#actions : APP_SHORTCUTS
  }

  /** Optional display identity: only from the gateway that owns this exact session. */
  get profile(): string {
    return this.#host.sid() === this.#sid ? this.#profile : ''
  }

  matches(id: string, key: Key): boolean {
    const item = this.actions.find(row => row.id === id)

    return item ? shortcutMatches(item, key) : false
  }

  /** A confirmed owner-scoped config readback supersedes a pending adoption read. */
  accept(result: ConfigGetResult, sid: string, identity?: ConfigGetResult): boolean {
    if (!sid || this.#host.sid() !== sid) {
      return false
    }

    // A corrupt/manual external edit never installs any partial action map.
    try {
      const display = displayConfig(result)
      const actions = effectiveShortcuts(display['tern_keybindings'] ?? {})
      this.#sid = sid
      this.#actions = actions
      this.#profile = display['tern_profile_identity'] === true && typeof identity?.display === 'string'
        ? identity.display
        : ''
      this.#read++
      this.#host.changed()

      return true
    } catch (error) {
      // Preserve the last valid map for THIS session. On a new session use defaults.
      if (this.#sid !== sid) {
        this.#sid = sid
        this.#actions = APP_SHORTCUTS
        this.#profile = ''
      }

      this.#read++
      this.#host.notice('Tern keybindings rejected: ' + reason(error) + '. Repair display.tern_keybindings in the owning profile config.')
      this.#host.changed()

      return false
    }
  }

  async refresh(): Promise<void> {
    const sid = this.#host.sid()
    const read = ++this.#read

    // A replacement session gets defaults before any asynchronous profile read.
    if (this.#sid !== sid) {
      this.#sid = sid
      this.#actions = APP_SHORTCUTS
      this.#profile = ''
      this.#host.changed()
    }

    if (!sid) {
      return
    }

    const current = () => this.#host.sid() === sid && this.#read === read

    try {
      // The pinned gateway's _profile_scoped derives the profile from session_id.
      const result = await rpc(this.#host.gw, 'config.get', { key: 'full', session_id: sid })

      if (!current()) {
        return
      }

      let identity: ConfigGetResult | undefined

      if (wantsProfile(result)) {
        try {
          identity = await rpc(this.#host.gw, 'config.get', { key: 'profile', session_id: sid })
        } catch (error) {
          if (!current()) {
            return
          }

          // Optional identity lookup failure must not disable valid bindings.
          this.#host.notice('Tern profile identity unavailable: ' + reason(error) + '.')
        }
      }

      if (current()) {
        this.accept(result, sid, identity)
      }
    } catch (error) {
      if (!current()) {
        return
      }

      // Keep the last valid map for this session, built-ins for a new one.
      this.#host.notice('Tern preferences unavailable; using current valid shortcuts: ' + reason(error) + '.')
      this.#host.changed()
    }
  }
}
