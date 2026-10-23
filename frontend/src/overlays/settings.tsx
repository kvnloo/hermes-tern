// A native Tern prefs sheet over the pinned Hermes config.get/config.set
// allowlist. No copied profile config, expanded secrets or synthetic RPCs.
// The live model and effort controls delegate to their existing session pickers.
import type { ChangeEvent, JSX, Key, PrefsControl, PrefsProps, PrefsRow } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { Composer } from '../draft/composer.js'
import { type Preference, preference, preferenceValue, PROFILE_PREFERENCES, type ProfileRow } from '../preferences/contracts.js'
import { readProfile, writeProfile } from '../preferences/transactions.js'
import { button } from '../view/ui/button.js'

import { openEffortPicker } from './effort.js'
import { openModelHub } from './modelHub.js'
import { openModelPicker } from './models.js'
import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

export type SettingsHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'session' | 'setEffort' | 'transcript'>

// Surface.render swaps callbacks before painting; native root ids must never be reused.
let nextSettingsRoot = 0

const SESSION_PAGE = 'session'
const GROUPS = [...new Set(PROFILE_PREFERENCES.map(field => field.group))]
interface Pending {
  field: Preference
  value: string
  expected: string
}

/** Session-affine overlay; no edits may escape its lifetime or target a successor pane. */
class SettingsSheet implements Overlay {
  readonly key = 'settings'
  readonly modal = true

  readonly #host: SettingsHost
  readonly #sid: string
  readonly #profileName: string
  readonly #root = `settings-${++nextSettingsRoot}`
  readonly #search = new Composer()
  readonly #editor = new Composer()
  #alive = true
  #generation = 0
  #rows = new Map<string, ProfileRow>()
  #page = SESSION_PAGE
  #selected: string | undefined
  #editing: string | undefined
  #choice: string | undefined
  #searching = false
  #status: 'loading' | 'ready' | 'error' = 'loading'
  #message = ''
  #busy: string | undefined
  #confirmation: Pending | undefined

  constructor(host: SettingsHost, sid: string, profile: string) {
    this.#host = host
    this.#sid = sid
    this.#profileName = profile
  }

  #live(): boolean {
    return this.#alive && this.#host.session.ref.live === this.#sid &&
      this.#host.session.info?.profile_name === this.#profileName &&
      this.#host.overlays.filter(item => item.key === this.key).at(-1) === this
  }

  #interactive(): boolean {
    return this.#live() && this.#host.overlays.at(-1) === this
  }

  onClose(): void {
    this.#alive = false
    this.#generation++
    this.#confirmation = undefined
  }

  async load(): Promise<void> {
    if (!this.#live() || this.#busy) {
      return
    }

    const generation = ++this.#generation
    this.#status = 'loading'
    this.#message = ''
    this.#host.changed()

    try {
      const rows = await readProfile({
        active: () => this.#live() && this.#generation === generation,
        gw: this.#host.gw,
        sid: this.#sid,
        profile: this.#profileName
      })

      if (!this.#live() || generation !== this.#generation) {
        return
      }

      this.#rows = new Map(rows.map(row => [row.field.key, row]))
      this.#status = 'ready'
    } catch (error) {
      if (!this.#live() || generation !== this.#generation) {
        return
      }

      this.#status = 'error'
      this.#message = errorText(error)
    }

    this.#host.changed()
  }

  #edit(field: Preference, input: unknown): void {
    if (!this.#interactive() || this.#status !== 'ready' || this.#busy || this.#confirmation) {
      return
    }

    try {
      const value = preferenceValue(field, input)
      const current = this.#rows.get(field.key)

      if (!current) {
        return
      }

      if (current.value === value) {
        this.#message = ''
      } else if (field.consequential) {
        this.#confirmation = { expected: current.value, field, value }
        this.#message = 'Explicit confirmation required for this profile-wide security policy.'
      } else {
        void this.#save({ expected: current.value, field, value })
      }
    } catch (error) {
      this.#message = errorText(error)
    }

    this.#host.changed()
  }

  async #save(intent: Pending): Promise<void> {
    if (!this.#interactive() || this.#busy) {
      return
    }

    this.#confirmation = undefined
    this.#busy = intent.field.key
    this.#message = 'Waiting for canonical Hermes readback…'
    this.#host.changed()

    try {
      const receipt = await writeProfile({
        active: () => this.#live(),
        gw: this.#host.gw,
        sid: this.#sid,
        profile: this.#profileName
      }, intent.field, intent.value, intent.expected)

      if (this.#live()) {
        this.#rows.set(receipt.key, { field: intent.field, value: receipt.value })
        this.#message = `Saved and verified by Hermes: ${intent.field.label}. Session pins are unchanged.`
      }
    } catch (error) {
      if (this.#live()) {
        this.#message = `Not confirmed: ${errorText(error)}`
      }
    } finally {
      this.#busy = undefined

      if (this.#live()) {
        this.#host.changed()
      }
    }
  }

  #activate(id: string): void {
    if (!this.#interactive() || this.#busy || this.#confirmation) {
      return
    }

    this.#selected = id

    if (id === 'session.model') {
      openModelPicker(this.#host)

      return
    }

    if (id === 'session.effort') {
      openEffortPicker(this.#host, false)

      return
    }

    if (id === 'session.hub') {
      openModelHub(this.#host)

      return
    }

    const row = this.#rows.get(id)

    if (!row || this.#status !== 'ready') {
      return
    }

    if (row.field.kind === 'switch') {
      this.#edit(row.field, row.value !== 'on')

      return
    }

    this.#editing = id
    this.#choice = row.field.kind === 'choice' ? row.value : undefined
    this.#editor.set(row.value)
    this.#host.changed()
  }

  #commitEditor(): void {
    const id = this.#editing
    const row = id && this.#rows.get(id)

    if (!row) {
      return
    }

    const input = row.field.kind === 'choice' ? this.#choice : this.#editor.text
    this.#editing = undefined

    if (input !== undefined) {
      this.#edit(row.field, input)
    }
  }

  #change(event: ChangeEvent): void {
    if (!this.#interactive() || !event.item || event.value === undefined) {
      return
    }

    const field = preference(event.item)

    if (field) {
      this.#editing = undefined
      this.#edit(field, event.value)
    }
  }

  #control(row: ProfileRow): PrefsControl {
    const { field, value } = row

    if (field.kind === 'switch') {
      return { k: 'switch', on: value === 'on' }
    }

    if (field.kind === 'choice') {
      return {
        k: 'choice',
        options: (field.options ?? []).map(word => ({ label: word, value: word })),
        value
      }
    }

    return { k: 'text', value }
  }

  #sessionRows(): PrefsRow[] {
    const info = this.#host.session.info
    return [
      {
        control: { act: 'model', k: 'action', label: info?.model ?? 'Choose session model' },
        hint: 'Live-session model pin; the existing model picker is authoritative.',
        id: 'session.model', label: 'Live model'
      },
      {
        control: { act: 'effort', k: 'action', label: info?.reasoning_effort ?? 'Choose session effort' },
        hint: 'Live-session effort only; does not rewrite the profile default.',
        id: 'session.effort', label: 'Live effort'
      },
      {
        control: { act: 'model-hub', k: 'action', label: 'Providers and model routes' },
        hint: 'The provider inventory is available. Auxiliary profile roles and fallback writes need a newer Hermes API.',
        id: 'session.hub', label: 'Model hub'
      }
    ]
  }

  #sections(): NonNullable<PrefsProps['sections']> {
    const query = this.#search.text.trim().toLowerCase()
    const matching = (text: string) => !query || text.toLowerCase().includes(query)
    const session = this.#sessionRows().filter(row => matching(`${row.id} ${row.label} ${row.hint ?? ''}`))
    const sections: Array<NonNullable<PrefsProps['sections']>[number]> = []

    if (this.#searching || this.#page === SESSION_PAGE) {
      sections.push({ id: SESSION_PAGE, page: SESSION_PAGE, rows: session, title: 'Current live session · temporary pins' })
    }

    if (this.#status !== 'ready') {
      return sections
    }

    for (const group of GROUPS) {
      if (!this.#searching && this.#page !== `profile.${group}`) {
        continue
      }

      const rows: PrefsRow[] = [...this.#rows.values()]
        .filter(row => row.field.group === group && matching(`${row.field.key} ${row.field.label} ${row.field.hint}`))
        .map(row => ({
          control: this.#control(row),
          hint: `${row.field.hint}\nConfirmed profile value: ${row.value}`,
          id: row.field.key,
          label: row.field.label,
          ...(this.#busy === row.field.key ? { disabled: 'Waiting for Hermes readback.' } : {})
        }))

      sections.push({ id: `profile.${group}`, page: `profile.${group}`, rows, title: `${group} · saved Hermes profile defaults` })
    }

    return sections
  }

  node(id: string): JSX.Element {
    if (!this.#live()) {
      return (
        <overlay anchor="bottom" key={this.#root} modal size="md">
          <col gap="md" key="expired">
            <text key="warning" text="This Settings sheet belongs to a previous session. Close and reopen it." />
            {button({ key: 'close', label: 'Close', onClick: () => this.#host.close(this) })}
          </col>
        </overlay>
      )
    }

    const ask = this.#confirmation

    if (ask) {
      return (
        <overlay anchor="bottom" key={this.#root} modal size="md">
          <col gap="md" key="confirm">
            <text key="heading" text="Confirm Hermes profile change" />
            <text key="scope" text={`Profile setting: ${ask.field.label}. This is persistent, not a live session pin.`} wrap="word" />
            <text key="value" text={`Change from ${ask.expected} to ${ask.value}?`} wrap="word" />
            <text key="warning" text="This changes the tool-approval policy for the profile. Enter and Escape cancel by default." wrap="word" />
            <row gap="sm" key="actions" role="omp.actions">
              {button({ key: 'cancel', label: 'Cancel (default)', onClick: () => { if (this.#interactive() && this.#confirmation === ask) { this.#confirmation = undefined; this.#host.changed() } } })}
              {button({ key: 'confirm', label: 'Confirm profile policy change', onClick: () => {
                if (this.#interactive() && this.#confirmation === ask) {
                  void this.#save(ask)
                }
              } })}
            </row>
          </col>
        </overlay>
      )
    }

    const sections = this.#sections()
    const shown = sections.flatMap(section => section.rows.map(row => row.id))

    if (!this.#selected || !shown.includes(this.#selected)) {
      this.#selected = shown[0]
    }

    return (
      <prefs
        key={this.#root}
        title="Hermes settings"
        lead={`Session: ${this.#sid}. Profile settings use Hermes config.get/set in that session's profile; session model/effort pins remain separate.`}
        page={this.#page}
        pages={[
          { group: 'Live', icon: 'session', id: SESSION_PAGE, label: 'Session' },
          ...GROUPS.map(group => ({ group: 'Hermes profile', id: `profile.${group}`, label: group }))
        ]}
        sections={sections}
        {...(this.#selected !== undefined ? { focus: this.#selected } : {})}
        cursor={this.#search.cursor}
        {...(this.#editing ? { editing: { cursor: this.#editor.cursor, draft: this.#editor.text, option: this.#choice, row: this.#editing } } : {})}
        {...(this.#searching ? { query: this.#search.text } : {})}
        onAction={{
          close: () => { if (this.#interactive()) { this.#host.close(this) } },
          edit: event => { if (event.value) { this.#activate(event.value) } },
          model: () => this.#activate('session.model'),
          'model-hub': () => this.#activate('session.hub'),
          effort: () => this.#activate('session.effort'),
          page: event => { if (this.#interactive() && event.value) { this.#page = event.value; this.#searching = false; this.#selected = undefined; this.#host.changed() } }
        }}
        onActivate={event => this.#activate(event.item)}
        onChange={event => this.#change(event)}
        onEdit={event => {
          if (!this.#interactive()) { return }
          const editor = this.#editing ? this.#editor : this.#search
          editor.edit(event)
          if (!this.#editing) { this.#searching = true }
          this.#host.changed()
        }}
        onSelect={event => { if (this.#interactive()) { this.#selected = event.item; this.#host.changed() } }}
        onUndo={() => { if (this.#interactive()) { (this.#editing ? this.#editor : this.#search).undo(); this.#host.changed() } }}
      >
        <col gap="sm" key="actions">
          {this.#status === 'loading' ? <text key="loading" text="Reading supported Hermes profile settings…" /> : null}
          {this.#message ? <text key="status" text={this.#message} tone={this.#status === 'error' ? 'error' : 'muted'} wrap="word" /> : null}
          <text key="limits" text="Auxiliary roles, fallbacks, provider credentials and arbitrary schema fields are read-only/unavailable on the pinned gateway. No credential data is fetched." wrap="word" />
          <row gap="sm" key="buttons" role="omp.actions">
            {button({ key: 'reload', label: 'Reload Hermes values', onClick: () => { if (this.#interactive() && !this.#busy) { void this.load() } } })}
            {button({ key: 'models', label: 'Model hub', onClick: () => { if (this.#interactive()) { openModelHub(this.#host) } } })}
            {button({ key: 'close', label: 'Close', onClick: () => this.#host.close(this) })}
          </row>
        </col>
      </prefs>
    )
  }

  onKey(key: Key): boolean {
    if (this.#confirmation) {
      if (key.name === 'enter' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        this.#confirmation = undefined
        this.#host.changed()
      }

      return true
    }

    if (!this.#interactive()) {
      if (key.name === 'escape') {
        this.#host.close(this)
      }

      return true
    }

    if (this.#editing) {
      if (key.name === 'escape') {
        this.#editing = undefined
      } else if (key.name === 'enter' && !key.shift && !key.alt) {
        this.#commitEditor()
      } else if (this.#choice !== undefined) {
        const field = preference(this.#editing)
        const options = field?.options ?? []
        const delta = key.name === 'left' || key.name === 'up' ? -1 : key.name === 'right' || key.name === 'down' ? 1 : 0

        if (delta && options.length) {
          const index = options.indexOf(this.#choice)
          this.#choice = options[(index + delta + options.length) % options.length]
        }
      } else {
        this.#editor.key(key)
      }

      this.#host.changed()
      return true
    }

    if (key.name === 'escape') {
      if (this.#searching) {
        this.#searching = false
        this.#search.set('')
        this.#host.changed()
      } else {
        this.#host.close(this)
      }

      return true
    }

    const pages = [SESSION_PAGE, ...GROUPS.map(group => `profile.${group}`)]

    if (key.name === 'tab' || (!this.#searching && (key.name === 'left' || key.name === 'right'))) {
      const delta = key.shift || key.name === 'left' ? -1 : 1
      this.#page = pages[(pages.indexOf(this.#page) + delta + pages.length) % pages.length] ?? SESSION_PAGE
      // Enter can precede the next paint: select the real row synchronously.
      this.#selected = this.#sections().flatMap(section => section.rows)[0]?.id
      this.#host.changed()
      return true
    }

    const rows = this.#sections().flatMap(section => section.rows.map(row => row.id))
    const selected = moveSelection(key, rows, this.#selected)

    if (selected !== undefined) {
      this.#selected = selected
      this.#host.changed()
      return true
    }

    if (key.name === 'enter' && this.#selected) {
      this.#activate(this.#selected)
    } else if (key.text || key.name === 'paste' || key.name === 'backspace') {
      this.#searching = true
      this.#search.key(key)
      this.#host.changed()
    }

    return true
  }
}

export function openSettings(host: SettingsHost): void {
  const sid = host.session.ref.live

  if (!sid) {
    host.transcript.notice('Start a live Hermes session before opening Settings.', 'warning')

    return
  }

  const profile = host.session.info?.profile_name

  if (typeof profile !== 'string' || !profile.trim()) {
    host.transcript.notice('Cannot open Settings before Hermes supplies a canonical session profile. Refresh the session and retry.', 'warning')

    return
  }

  const overlay = new SettingsSheet(host, sid, profile)
  host.open(overlay)
  void overlay.load()
}
