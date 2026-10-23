// Native, lazy read-only provider/model inventory. The pinned Hermes gateway
// does not have model.hub.get/set, auxiliary-role/fallback revision writes,
// or credential-safe provider settings. Live model selection stays in /model.
import type { Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { rpc } from '../wire/rpc.js'

import { openModelPicker } from './models.js'
import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

export type ModelHubHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'session' | 'setEffort' | 'transcript'>

interface Provider {
  slug: string
  name: string
  authenticated: boolean | undefined
  count: number
}

let nextModelHubRoot = 0

export function openModelHub(host: ModelHubHost): void {
  const sid = host.session.ref.live

  if (!sid) {
    host.transcript.notice('Start a live Hermes session before opening the model hub.', 'warning')

    return
  }

  const profile = host.session.info?.profile_name
  if (typeof profile !== 'string' || !profile.trim()) {
    host.transcript.notice('Cannot open the model hub without a canonical owner profile. Refresh the session and retry.', 'warning')
    return
  }

  const nativeRoot = `model-hub-${++nextModelHubRoot}`
  let alive = true
  let generation = 0
  let status: 'loading' | 'ready' | 'error' = 'loading'
  let message = ''
  let providers: Provider[] = []
  let selected: string | undefined

  const live = () => alive && host.session.ref.live === sid && host.session.info?.profile_name === profile && host.overlays.filter(item => item.key === overlay.key).at(-1) === overlay
  const interactive = () => live() && host.overlays.at(-1) === overlay

  const load = async () => {
    const version = ++generation
    status = 'loading'
    message = ''
    host.changed()

    try {
      const result = await rpc(host.gw, 'model.options', { session_id: sid, profile })

      if (!live() || generation !== version) {
        return
      }

      // Intentionally project only public inventory metadata. Never pass
      // API URLs, auth material, capability blobs or full config into Tern.
      providers = (result.providers ?? []).map(item => ({
        authenticated: item.authenticated === true ? true : item.authenticated === false ? false : undefined,
        count: item.models?.length ?? 0,
        name: item.name,
        slug: item.slug
      }))
      selected = providers[0]?.slug
      status = 'ready'
    } catch (error) {
      if (!live() || generation !== version) {
        return
      }

      status = 'error'
      message = errorText(error)
    }

    host.changed()
  }

  const chooseSession = () => {
    if (interactive()) {
      openModelPicker(host)
    }
  }

  const overlay: Overlay = {
    key: 'model-hub',
    modal: true,
    onClose: () => { alive = false; generation++ },
    node: () => {
      const entries: PickerItem[] = providers.map(item => ({
        detail: `${item.authenticated === false ? 'Not configured' : item.authenticated ? 'Configured' : 'Authentication unknown'} · ${item.count} listed models`,
        id: item.slug,
        label: item.name,
        title: item.slug
      }))
      const current = providers.find(item => item.slug === selected)

      return (
        <picker
          key={nativeRoot}
          title="Hermes model hub"
          noun="providers"
          icon="cpu"
          state={status}
          {...(message ? { message } : {})}
          items={entries}
          order={entries.map(item => item.id)}
          {...(selected ? { selected } : {})}
          preview="side"
          size="lg"
          empty="No providers in this profile"
          actions={[
            { id: 'reload', label: 'Reload inventory' },
            { id: 'model', keys: ['enter'], label: 'Choose live session model', primary: true },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' }
          ]}
          onAction={{
            close: () => { if (interactive()) { host.close(overlay) } },
            model: chooseSession,
            reload: () => { if (interactive()) { void load() } }
          }}
          onActivate={chooseSession}
          onSelect={event => { if (interactive()) { selected = event.item; host.changed() } }}
        >
          <col gap="sm" key="detail">
            <text key="profile" text="Provider inventory is bound to the opened session's Hermes profile; the live picker stays authoritative." wrap="word" />
            {current ? <text key="selected" text={`${current.name} (${current.slug}): ${current.count} models; ${current.authenticated === false ? 'setup required' : 'status from Hermes'}.`} wrap="word" /> : null}
            <text key="roles" text="Auxiliary role assignments: unavailable on this pinned gateway (no model.hub.get/set)." wrap="word" />
            <text key="fallbacks" text="Fallback route management: unavailable without a profile revision/confirmation API." wrap="word" />
            <text key="credentials" text="Provider credential setup must use Hermes' supported setup flow; this sheet never accepts or displays secrets." wrap="word" />
          </col>
        </picker>
      )
    },
    onKey: (key: Key) => {
      if (key.name === 'escape' && interactive()) {
        host.close(overlay)
      } else if (interactive() && key.name === 'enter') {
        chooseSession()
      } else if (interactive() && key.name === 'r') {
        void load()
      } else if (interactive()) {
        selected = moveSelection(key, providers.map(item => item.slug), selected) ?? selected
      }

      return true
    }
  }

  host.open(overlay)
  void load()
}
