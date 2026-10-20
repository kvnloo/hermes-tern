// An ask_control call's sheet: Ripple's fast control drawn with Tern's own components, in the
// shapes and roles omp's ask sheet uses (`omp.overlay.ask`, its option list and action row), so
// Tern sizes it like the composer and reads the pane as waiting for input. What a key, a click or a
// transcript means is the shared interaction model's (vendor/ripple/state.ts); this file only draws
// its state and turns Tern's keys and clicks into its inputs.

import type { JSX, Key } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import { overlayKey } from '../core/ids.js'
import type { Overlay } from '../overlays/overlay.js'
import { isCtrlC } from '../prompts/ask.js'
import { actionsRow, button } from '../view/ui/button.js'
import {
  type ControlInput,
  type ControlState,
  type FastControl,
  initialState,
  type Outcome,
  rowsOf,
  step,
  stepOf
} from '../vendor/ripple/index.js'

/** Where a Tern answer says it came from (`Intent.surface`). */
export const SURFACE = 'tern'

/** The overlay key of call `id`'s sheet. */
export const controlKey = (id: string) => overlayKey(`control:${id}`)

/** A control's sheet on the stack, and how to feed it an input from outside (a transcript). */
export interface ControlSheet {
  readonly overlay: Overlay
  feed(input: ControlInput): void
}

/** What the sheet reaches of the app. */
export interface ControlSheetHost {
  changed(): void
  /** The control was answered or put away; the host closes the sheet. */
  settle(outcome: Outcome): void
}

/** `1–3 picks · ↑↓ moves · enter sends · esc not now`: the keys this control takes. */
export function keyHint(control: FastControl): string {
  const n = rowsOf(control).length
  const esc = 'esc not now'

  switch (control.kind) {
    case 'slider':
      return `←→ ±${stepOf(control)} · pgup/pgdn ±${stepOf(control) * 10} · home/end · enter sends · ${esc}`
    case 'confirm':
      return `y / n · enter sends the highlighted one · ${esc}`
    case 'choice':
      if (control.multiple) {
        return `1–${n} or space checks · ↑↓ moves · enter sends · ${esc}`
      }

      return `1–${n} picks · ↑↓ moves · enter picks the highlighted one · ${esc}`
    case 'candidates':
      return `1–${n} picks · ↑↓ moves · enter picks the highlighted one · ${esc}`
  }
}

/** Tern's key as the interaction model names it; undefined for a key it has no word for. */
export function keyName(k: Key): string | undefined {
  if (k.ctrl || k.meta || k.alt) {
    return undefined
  }

  return k.name === 'return' ? 'enter' : k.name === 'esc' ? 'escape' : k.name
}

/** The sheet for `control` (an ask_control call `ref`'s). */
export function controlSheet(ref: string, control: FastControl, host: ControlSheetHost): ControlSheet {
  let state: ControlState = initialState(control)
  const key = controlKey(ref)

  const feed = (input: ControlInput) => {
    const next = step(state, input, SURFACE)

    state = next.state

    if (next.outcome) {
      host.settle(next.outcome)
    } else if (!next.ignored) {
      host.changed()
    }
  }

  /** The highlight on row `i`: the renderer's own state, it answers nothing. */
  const focus = (i: number) => {
    state = { ...state, focus: i }
    host.changed()
  }

  const overlay: Overlay = {
    cancel: () => host.settle({ kind: 'dismiss' }),
    key,
    modal: true,
    node: id => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text={control.prompt} />
          {control.kind === 'confirm' && control.detail ? <text key="detail" spans={[{ s: 'muted', t: control.detail }]} wrap="word" /> : null}
          {control.kind === 'slider' ? slider(state, control, feed) : rows(`${id}.body.rows`, state, feed, focus)}
          <text key="hint" role="omp.ask.hint" spans={[{ s: 'dim', t: keyHint(control) }]} wrap="word" />
          {actionsRow([
            { hint: 'escape', key: 'skip', keys: ['escape'], label: 'Not now', onClick: () => feed({ key: 'escape', kind: 'key' }) },
            { hint: 'enter', key: 'submit', keys: ['enter'], kind: 'primary', label: 'Send', onClick: () => feed({ key: 'enter', kind: 'key' }) }
          ])}
        </col>
      </overlay>
    ),
    onKey: k => {
      if (isCtrlC(k)) {
        host.settle({ kind: 'dismiss' })

        return true
      }

      const name = keyName(k)

      if (name) {
        feed({ key: name, kind: 'key' })
      }

      // A sheet that must be answered takes every key, as the clarify sheet does.
      return true
    }
  }

  return { feed, overlay }
}

/** The options (or candidates, or confirm and cancel), numbered; checked rows of a multiple choice ticked. */
function rows(id: string, state: ControlState, feed: (input: ControlInput) => void, focus: (i: number) => void): JSX.Element {
  const { control } = state
  const list = rowsOf(control)
  const multiple = control.kind === 'choice' && control.multiple === true
  const at = (item: string) => list.findIndex(r => `${id}.${r.id}` === item)

  return (
    <list
      key="rows"
      onActivate={ev => {
        const i = at(ev.item)
        const row = list[i]

        if (row) {
          feed({ id: row.id, kind: 'pick' })
        }
      }}
      onSelect={ev => {
        const i = at(ev.item)

        // A click selects, as the clarify sheet's list does: the highlight follows it.
        if (i >= 0) {
          focus(i)
        }
      }}
      role="omp.ask.options"
      {...optional('selected', list[state.focus] ? `${id}.${list[state.focus]?.id}` : undefined)}
    >
      {list.map((r, i) => {
        const checked = multiple && state.picked.includes(r.id)

        return (
          <item
            key={r.id}
            {...optional('detail', r.detail ? [{ t: r.detail }] : undefined)}
            {...optional('icon', checked ? 'check' : undefined)}
            label={[
              { s: 'dim', t: `${i + 1}  ` },
              { t: r.label }
            ]}
            role={multiple ? 'omp.ask.check' : 'omp.ask.option'}
            {...optional('tone', checked ? 'success' : undefined)}
            {...optional('value', r.artifactVersion ? [{ s: 'dim', t: `v${r.artifactVersion}` }] : undefined)}
          />
        )
      })}
    </list>
  )
}

/** A slider: its meter, its value between −/+ buttons, and its range. */
function slider(state: ControlState, control: Extract<FastControl, { kind: 'slider' }>, feed: (input: ControlInput) => void): JSX.Element {
  const unit = control.unit ? ` ${control.unit}` : ''
  const by = stepOf(control)

  return (
    <col gap="sm" key="slider" role="hermes.control.slider">
      <meter
        key="meter"
        label={[{ s: 'strong', t: `${state.value}${unit}` }]}
        total={[{ s: 'dim', t: `${control.min}–${control.max}${unit}` }]}
        value={(state.value - control.min) / (control.max - control.min)}
      />
      <row align="center" gap="sm" key="nudge">
        {button({ hint: 'left', key: 'less', keys: ['left'], label: `−${by}`, onClick: () => feed({ kind: 'set', value: state.value - by }) })}
        {button({ hint: 'right', key: 'more', keys: ['right'], label: `+${by}`, onClick: () => feed({ kind: 'set', value: state.value + by }) })}
      </row>
    </col>
  )
}
