// The owning Hermes session's display settings are the only preference source.
// Adapted from Hermes ui-tsp/src/binding-preferences.ts; no local auth/config authority.

import type { SettingsGetResult } from '@hermes/shared/gateway-events'
import type { Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { APP_SHORTCUTS, effectiveShortcuts, shortcutMatches, type Shortcut } from './actions.js'

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

  /** A confirmed native Settings readback may supersede an adoption read. */
  accept(result: SettingsGetResult, sid: string): boolean {
    if (!sid || this.#host.sid() !== sid) {
      return false
    }

    // A corrupt/manual external edit never installs any partial action map.
    try {
      const actions = effectiveShortcuts(result.fields['display.tern_keybindings']?.value ?? {})
      this.#sid = sid
      this.#actions = actions
      this.#profile = result.fields['display.tern_profile_identity']?.value === true ? result.profile : ''
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
      this.#host.notice(`Tern keybindings rejected: ${error instanceof Error ? error.message : String(error)}. Repair display.tern_keybindings in Settings.`)
      this.#host.changed()

      return false
    }
  }

  async refresh(): Promise<void> {
    const sid = this.#host.sid()
    const read = ++this.#read

    if (!sid) {
      return
    }

    try {
      const result = await this.#host.gw.request<SettingsGetResult>('settings.get', { session_id: sid })

      if (read === this.#read && this.#host.sid() === sid) {
        this.accept(result, sid)
      }
    } catch (error) {
      if (read !== this.#read || this.#host.sid() !== sid) {
        return
      }

      if (this.#sid !== sid) {
        this.#sid = sid
        this.#actions = APP_SHORTCUTS
        this.#profile = ''
      }

      // A gateway that does not offer settings.get keeps built-in shortcuts.
      this.#host.notice(`Tern preferences unavailable; using current valid shortcuts: ${error instanceof Error ? error.message : String(error)}.`)
      this.#host.changed()
    }
  }
}
