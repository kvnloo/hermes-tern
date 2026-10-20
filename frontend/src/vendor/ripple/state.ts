// Vendored from Ripple (https://github.com/kvnloo/ripple, MIT), src/fast-controls/state.ts at d160863.
// Unchanged but for this header: the fast-control schema and interaction model every Ripple renderer shares.

// How a control is answered, the same on every renderer: a pure step from (state, input) to the next
// state and, when the owner has answered or put the control away, its outcome. Renderers translate
// their own events into `ControlInput` (a key name, a pointer pick, a pointer set, a transcript) and
// draw `ControlState`; none of them decides what a key means. Keyboard first: number keys pick,
// arrows move or nudge, Enter answers, Escape puts the control away without an answer.

import type { ControlCandidate, FastControl, Intent } from './schema.js'

export interface ControlState {
  readonly control: FastControl
  /** The highlighted row: an option, a candidate, or 0 confirm / 1 cancel. */
  readonly focus: number
  /** A multiple choice's checked option ids, in option order. */
  readonly picked: readonly string[]
  /** A slider's current value. */
  readonly value: number
}

/**
 * What a renderer feeds in. Key names are lower-case DOM/Tern names: `1`…`9`, `up`, `down`, `left`,
 * `right`, `home`, `end`, `pageup`, `pagedown`, `enter`, `space`, `escape`, `y`, `n`.
 */
export type ControlInput =
  | { kind: 'key'; key: string }
  /** A pointer click on an option, a candidate, or `confirm` / `cancel`. */
  | { kind: 'pick'; id: string }
  /** A pointer set a slider (a tick, a −/+ button). */
  | { kind: 'set'; value: number }
  /** Free text from a transcript (voice) or a typed reply. */
  | { kind: 'say'; text: string }

export type Outcome = { kind: 'answer'; intent: Intent } | { kind: 'dismiss' }

export interface Step {
  readonly state: ControlState
  /** Unset: the control is still open. */
  readonly outcome?: Outcome
  /** The input meant nothing here (an unknown key, an unmatched transcript). */
  readonly ignored?: true
}

/** The rows a control lists (choice options, candidates, or confirm / cancel). */
export function rowsOf(control: FastControl): readonly ControlCandidate[] {
  switch (control.kind) {
    case 'choice':
      return control.options
    case 'candidates':
      return control.candidates
    case 'confirm':
      return [
        { id: 'confirm', label: control.confirmLabel ?? 'Confirm' },
        { id: 'cancel', label: control.cancelLabel ?? 'Cancel' }
      ]
    case 'slider':
      return []
  }
}

/** A slider's step: its own, else 1/100 of its range. */
export function stepOf(control: Extract<FastControl, { kind: 'slider' }>): number {
  return control.step ?? (control.max - control.min) / 100
}

/** `value` on the slider: clamped, and snapped to its steps from `min`. */
export function snap(control: Extract<FastControl, { kind: 'slider' }>, value: number): number {
  const step = stepOf(control)
  const snapped = control.min + Math.round((value - control.min) / step) * step
  // Float steps (0.1) drift; keep as many decimals as the step has.
  const decimals = (String(step).split('.')[1] ?? '').length

  return Math.min(control.max, Math.max(control.min, Number(snapped.toFixed(decimals))))
}

export function initialState(control: FastControl): ControlState {
  const value = control.kind === 'slider' ? snap(control, control.value ?? (control.min + control.max) / 2) : 0

  return { control, focus: 0, picked: [], value }
}

/** The intent that answers `state` with row `id` (or the multiple choice's checked rows, or the slider's value). */
export function intentOf(state: ControlState, surface: string, id?: string): Intent {
  const { control } = state
  const base = { controlId: control.id, surface }

  if (control.kind === 'slider') {
    return { ...base, label: `${state.value}${control.unit ? ` ${control.unit}` : ''}`, value: state.value }
  }

  const rows = rowsOf(control)

  if (control.kind === 'choice' && control.multiple && id === undefined) {
    const picked = rows.filter(r => state.picked.includes(r.id))

    return { ...base, label: picked.map(r => r.label).join(', '), value: picked.map(r => r.id) }
  }

  const row = rows.find(r => r.id === id) ?? rows[state.focus]

  if (!row) {
    throw new Error(`control ${control.id} has no row ${id ?? state.focus}`)
  }

  return {
    ...base,
    label: row.label,
    value: row.id,
    ...(row.artifactVersion !== undefined ? { artifactVersion: row.artifactVersion } : {})
  }
}

const answer = (state: ControlState, surface: string, id?: string): Step => ({
  outcome: { intent: intentOf(state, surface, id), kind: 'answer' },
  state
})

const ignored = (state: ControlState): Step => ({ ignored: true, state })

function toggle(state: ControlState, id: string): ControlState {
  const order = rowsOf(state.control).map(r => r.id)
  const on = state.picked.includes(id) ? state.picked.filter(p => p !== id) : [...state.picked, id]

  return { ...state, focus: Math.max(0, order.indexOf(id)), picked: order.filter(o => on.includes(o)) }
}

/** One input: the next state, and the outcome when the control is answered or put away. */
export function step(state: ControlState, input: ControlInput, surface: string): Step {
  const { control } = state

  if (input.kind === 'say') {
    return heard(state, input.text, surface)
  }

  if (control.kind === 'slider') {
    return sliderStep(state, control, input, surface)
  }

  const rows = rowsOf(control)
  const multiple = control.kind === 'choice' && control.multiple === true

  if (input.kind === 'set') {
    return ignored(state)
  }

  if (input.kind === 'pick') {
    if (!rows.some(r => r.id === input.id)) {
      return ignored(state)
    }

    return multiple ? { state: toggle(state, input.id) } : answer(state, surface, input.id)
  }

  const key = input.key
  const n = /^[1-9]$/.test(key) ? Number(key) : 0

  if (key === 'escape') {
    return { outcome: { kind: 'dismiss' }, state }
  }

  if (control.kind === 'confirm' && (key === 'y' || key === 'n')) {
    return answer(state, surface, key === 'y' ? 'confirm' : 'cancel')
  }

  if (n && n <= rows.length) {
    const id = rows[n - 1]?.id ?? ''

    return multiple ? { state: toggle(state, id) } : answer(state, surface, id)
  }

  const last = rows.length - 1
  const moves: Record<string, number> = {
    down: state.focus >= last ? 0 : state.focus + 1,
    end: last,
    home: 0,
    left: state.focus <= 0 ? last : state.focus - 1,
    right: state.focus >= last ? 0 : state.focus + 1,
    up: state.focus <= 0 ? last : state.focus - 1
  }
  const moved = moves[key]

  if (moved !== undefined) {
    return { state: { ...state, focus: moved } }
  }

  if (key === 'space' && multiple) {
    return { state: toggle(state, rows[state.focus]?.id ?? '') }
  }

  if (key === 'enter') {
    if (!multiple) {
      return answer(state, surface)
    }

    // Nothing checked: Enter takes the highlighted row, as a single pick would.
    const checked = state.picked.length ? state : toggle(state, rows[state.focus]?.id ?? '')

    return answer(checked, surface)
  }

  return ignored(state)
}

function sliderStep(
  state: ControlState,
  control: Extract<FastControl, { kind: 'slider' }>,
  input: Exclude<ControlInput, { kind: 'say' }>,
  surface: string
): Step {
  const to = (value: number): Step => ({ state: { ...state, value: snap(control, value) } })
  const unit = stepOf(control)

  if (input.kind === 'set') {
    return to(input.value)
  }

  if (input.kind === 'pick') {
    return ignored(state)
  }

  const nudges: Record<string, number> = {
    down: -unit,
    left: -unit,
    pagedown: -unit * 10,
    pageup: unit * 10,
    right: unit,
    up: unit
  }

  if (input.key in nudges) {
    return to(state.value + (nudges[input.key] ?? 0))
  }

  switch (input.key) {
    case 'home':
      return to(control.min)
    case 'end':
      return to(control.max)
    case 'enter':
      return answer(state, surface)
    case 'escape':
      return { outcome: { kind: 'dismiss' }, state }
    default:
      return ignored(state)
  }
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']
const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
const YES = /^(yes|yeah|yep|sure|ok|okay|confirm|do it|go ahead)\b/
const NO = /^(no|nope|cancel|don t|do not|stop)\b/

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]|\.(?!\d)/g, ' ')
    // "the second one": the "one" names a row, not row one.
    .replace(new RegExp(`\\b(${ORDINALS.join('|')}) one\\b`, 'g'), '$1')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A transcript (voice, or a typed reply) as an answer when it names exactly one row: its number
 * ("two", "the second one", "option 2"), its label or its id; yes/no for a confirm; a number for a
 * slider. Anything ambiguous is ignored rather than guessed.
 */
function heard(state: ControlState, transcript: string, surface: string): Step {
  const { control } = state
  const said = words(transcript)

  if (!said) {
    return ignored(state)
  }

  if (control.kind === 'slider') {
    const number = said.match(/-?\d+(?:\.\d+)?/)

    if (!number) {
      return ignored(state)
    }

    return answer({ ...state, value: snap(control, Number(number[0])) }, surface)
  }

  if (control.kind === 'confirm') {
    if (YES.test(said)) {
      return answer(state, surface, 'confirm')
    }

    if (NO.test(said)) {
      return answer(state, surface, 'cancel')
    }
  }

  const rows = rowsOf(control)
  const hits = new Set<number>()

  rows.forEach((row, i) => {
    const label = words(row.label)
    const byLabel = label.length > 0 && (said === label || ` ${said} `.includes(` ${label} `))
    const byId = ` ${said} `.includes(` ${words(row.id)} `)
    const ordinal = ORDINALS[i] ?? ''
    const number = NUMBERS[i] ?? ''
    const byNumber = new RegExp(`(^|\\s)(${i + 1}|${ordinal}|${number}|option ${i + 1}|number ${i + 1})(\\s|$)`).test(said)

    if (byLabel || byId || byNumber) {
      hits.add(i)
    }
  })

  if (hits.size !== 1) {
    return ignored(state)
  }

  const [at] = [...hits]
  const id = rows[at ?? 0]?.id ?? ''

  if (control.kind === 'choice' && control.multiple) {
    return answer(toggle({ ...state, picked: [] }, id), surface)
  }

  return answer(state, surface, id)
}
