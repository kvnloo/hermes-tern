// Runtime boundary to the exact OpenUI experiment shipped by a Hermes
// source checkout. No copied validator or unreviewed schema approximation.
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { VisualBundle } from '../visuals.js'

import { record } from './json.js'

/** Public exports of ui-tsp/experiments/openui-preview/src/bundle.mjs. */
export interface OpenUiContract {
  readonly MAX_BYTES: number
  validateBundle(input: unknown): VisualBundle
  fingerprints(): Promise<unknown>
  assertCurrent(bundle: VisualBundle, scope: string, fingerprints: unknown): void
}

function isOpenUiContract(value: unknown): value is OpenUiContract {
  const module = record(value)

  return Boolean(
    module &&
      module['MAX_BYTES'] === 8 * 1024 * 1024 &&
      typeof module['validateBundle'] === 'function' &&
      typeof module['fingerprints'] === 'function' &&
      typeof module['assertCurrent'] === 'function'
  )
}

/** Require the reviewed real experiment, including its original hash inputs. */
export async function openUiContract(): Promise<OpenUiContract> {
  const root = process.env['HERMES_PYTHON_SRC_ROOT']

  if (!root || !isAbsolute(root)) {
    throw new Error('OpenUI preview requires an absolute HERMES_PYTHON_SRC_ROOT pointing to the Hermes source checkout.')
  }

  const url = pathToFileURL(join(root, 'ui-tsp/experiments/openui-preview/src/bundle.mjs')).href
  let loaded: unknown

  try {
    loaded = await import(/* @vite-ignore */ url)
  } catch {
    throw new Error('The Hermes checkout has no OpenUI preview validator. Use the ui-tsp donor checkout to preview prepared files.')
  }

  if (!isOpenUiContract(loaded)) {
    throw new Error('Unsupported Hermes OpenUI preview validator exports.')
  }

  return loaded
}
