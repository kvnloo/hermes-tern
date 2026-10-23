// Runtime boundary to the original, packaged OpenUI preview experiment.
// The tracked source assets ship beside dist/entry.js with the plugin.
// Neither Hermes' pinned runtime nor a donor checkout supplies the validator.
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { VisualBundle } from '../visuals.js'

import { record } from './json.js'

/** Public exports of openui/openui-preview/src/bundle.mjs (reviewed donor). */
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

/**
 * Vitest executes src/wire/openui.ts; the production esbuild output executes
 * dist/entry.js. Both resolve the same tracked plugin-local source directory.
 * No environment variable, working directory or Hermes fork may redirect it.
 */
function packagedValidatorUrl(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = basename(here) === 'wire' && basename(dirname(here)) === 'src'
  const frontend = source ? resolve(here, '../..') : resolve(here, '..')

  return pathToFileURL(join(frontend, 'openui/openui-preview/src/bundle.mjs')).href
}

/** Load the reviewed validator and its full on-disk fingerprint inputs. */
export async function openUiContract(): Promise<OpenUiContract> {
  let loaded: unknown

  try {
    loaded = await import(/* @vite-ignore */ packagedValidatorUrl())
  } catch {
    throw new Error('Packaged OpenUI preview validator or a required source asset is missing; reinstall the hermes-tern plugin.')
  }

  if (!isOpenUiContract(loaded)) {
    throw new Error('Unsupported packaged OpenUI preview validator exports.')
  }

  return loaded
}
