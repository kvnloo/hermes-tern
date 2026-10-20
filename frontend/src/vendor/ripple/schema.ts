// Vendored from Ripple (https://github.com/kvnloo/ripple, MIT), src/fast-controls/schema.ts at d160863.
// Unchanged but for this header: the fast-control schema and interaction model every Ripple renderer shares.

// Ephemeral fast controls: the small task-specific questions an agent puts in front of the owner
// (a choice, a slider, a confirm, a pick from candidates), as one constrained JSON shape that every
// renderer draws natively (Dash/React Native, the web review surface, Tern over TSP). Anything
// outside the shape is refused, so a model cannot smuggle markup or scripts into a native surface.
//
// The owner's answer comes back as declared intent (`Intent`). This file is the canonical copy;
// z0bridge (src/fx/controls.ts) keeps the same shape and checks, and hermes-tern vendors this
// directory unchanged. Renderer-neutral: no React, no DOM, no Tern.

/** A choice option or a candidate. */
export interface ControlOption {
  id: string
  label: string
  detail?: string
}

/** A candidate may name the fx0 artifact version it shows. */
export interface ControlCandidate extends ControlOption {
  artifactVersion?: number
}

export type FastControl =
  | { id: string; kind: 'choice'; prompt: string; options: ControlOption[]; multiple?: boolean }
  | { id: string; kind: 'slider'; prompt: string; min: number; max: number; step?: number; value?: number; unit?: string }
  | { id: string; kind: 'confirm'; prompt: string; confirmLabel?: string; cancelLabel?: string; detail?: string }
  | { id: string; kind: 'candidates'; prompt: string; candidates: ControlCandidate[] }

export type FastControlKind = FastControl['kind']

/** The owner's answer to a control, returned as declared intent. */
export interface Intent {
  /** Control id (FastControl.id or the `data-intent` id inside an fx0 HTML control). */
  controlId: string
  /** Option/candidate id (ids for a multiple choice), slider number, or `confirm`/`cancel`. */
  value: string | number | boolean | string[]
  /** Human label of what was picked, as shown. */
  label?: string
  /** fx0 artifact version the choice was made on, when it came from HTML or a candidate. */
  artifactVersion?: number
  /** Where the answer was given, e.g. `dash-live-surface`, `ripple-fast-control`, `tern`. */
  surface?: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
export const MAX_OPTIONS = 8
export const LIMITS = { cancelLabel: 40, confirmLabel: 40, detail: 160, label: 80, prompt: 200, unit: 12 } as const

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null
}

function options(raw: unknown): ControlCandidate[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_OPTIONS) {
    return null
  }

  const seen = new Set<string>()
  const out: ControlCandidate[] = []

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return null
    }

    const row = item as Record<string, unknown>
    const id = typeof row['id'] === 'string' && ID.test(row['id']) ? row['id'] : null
    const label = text(row['label'], LIMITS.label)

    if (!id || !label || seen.has(id)) {
      return null
    }

    seen.add(id)
    const detail = row['detail'] === undefined ? undefined : text(row['detail'], LIMITS.detail)

    if (detail === null) {
      return null
    }

    const version = row['artifactVersion']

    if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
      return null
    }

    out.push({ id, label, ...(detail ? { detail } : {}), ...(version !== undefined ? { artifactVersion: version as number } : {}) })
  }

  return out
}

/** `raw` as a control, or null when it is not one exactly. */
export function parseFastControl(raw: unknown): FastControl | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const value = raw as Record<string, unknown>
  const id = typeof value['id'] === 'string' && ID.test(value['id']) ? value['id'] : null
  const prompt = text(value['prompt'], LIMITS.prompt)

  if (!id || !prompt) {
    return null
  }

  switch (value['kind']) {
    case 'choice': {
      const list = options(value['options'])
      const multiple = value['multiple']

      if (!list || (multiple !== undefined && typeof multiple !== 'boolean')) {
        return null
      }

      return {
        id,
        kind: 'choice',
        options: list.map(({ detail, id: o, label }) => ({ id: o, label, ...(detail ? { detail } : {}) })),
        prompt,
        ...(multiple ? { multiple: true } : {})
      }
    }

    case 'candidates': {
      const list = options(value['candidates'])

      return list ? { candidates: list, id, kind: 'candidates', prompt } : null
    }

    case 'slider': {
      const { max, min, step, unit } = value
      const initial = value['value']

      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return null
      }

      if (step !== undefined && (typeof step !== 'number' || !(step > 0) || step > max - min)) {
        return null
      }

      if (initial !== undefined && (typeof initial !== 'number' || initial < min || initial > max)) {
        return null
      }

      const u = unit === undefined ? undefined : text(unit, LIMITS.unit)

      if (u === null) {
        return null
      }

      return {
        id,
        kind: 'slider',
        max,
        min,
        prompt,
        ...(step !== undefined ? { step } : {}),
        ...(initial !== undefined ? { value: initial } : {}),
        ...(u ? { unit: u } : {})
      }
    }

    case 'confirm': {
      const confirmLabel = value['confirmLabel'] === undefined ? undefined : text(value['confirmLabel'], LIMITS.confirmLabel)
      const cancelLabel = value['cancelLabel'] === undefined ? undefined : text(value['cancelLabel'], LIMITS.cancelLabel)
      const detail = value['detail'] === undefined ? undefined : text(value['detail'], LIMITS.prompt)

      if (confirmLabel === null || cancelLabel === null || detail === null) {
        return null
      }

      return {
        id,
        kind: 'confirm',
        prompt,
        ...(confirmLabel ? { confirmLabel } : {}),
        ...(cancelLabel ? { cancelLabel } : {}),
        ...(detail ? { detail } : {})
      }
    }

    default:
      return null
  }
}

/** `raw` as an intent, or null when it is not one exactly. */
export function parseIntent(raw: unknown): Intent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const value = raw as Record<string, unknown>
  const controlId = typeof value['controlId'] === 'string' && ID.test(value['controlId']) ? value['controlId'] : null

  if (!controlId) {
    return null
  }

  const v = value['value']

  const ok =
    (typeof v === 'string' && v.length > 0 && v.length <= 200) ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'boolean' ||
    (Array.isArray(v) && v.length > 0 && v.length <= MAX_OPTIONS && v.every(item => typeof item === 'string' && item.length <= 200))

  if (!ok) {
    return null
  }

  const label = value['label'] === undefined ? undefined : text(value['label'], 120)
  const surface = value['surface'] === undefined ? undefined : text(value['surface'], 40)
  const version = value['artifactVersion']

  if (label === null || surface === null) {
    return null
  }

  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    return null
  }

  return {
    controlId,
    value: v as Intent['value'],
    ...(label ? { label } : {}),
    ...(version !== undefined ? { artifactVersion: version as number } : {}),
    ...(surface ? { surface } : {})
  }
}

/** `db = Postgres`: an intent in one line, for logs and receipts. */
export function describeIntent(intent: Intent): string {
  const shown = intent.label ?? (Array.isArray(intent.value) ? intent.value.join(', ') : String(intent.value))

  return `${intent.controlId} = ${shown}${intent.artifactVersion ? ` (html v${intent.artifactVersion})` : ''}`
}
