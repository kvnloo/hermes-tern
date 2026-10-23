// A private file round-trip for a plan revision, adapted from Hermes ui-tsp.
// The plan content is never interpolated into a shell command or the composer.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type PlanOpener = (path: string) => void | Promise<void>

/** A fixed argv invocation; never run a shell or use user-controlled plan bytes as arguments. */
export const openPlanFile: PlanOpener = path => {
  const inTern = Boolean(process.env.TERN_WINDOW_KEY)
  const command = (process.env.VISUAL || process.env.EDITOR || 'vi').trim().split(/\s+/)
  const argv = inTern ? ['tern', 'open', '--wait', path] : [...command, path]
  const wasRaw = process.stdin.isRaw

  try {
    if (!inTern && process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }

    const result = spawnSync(argv[0] || 'vi', argv.slice(1), { stdio: inTern ? 'pipe' : 'inherit' })

    if (result.error) {
      throw result.error
    }

    if (result.status !== 0) {
      throw new Error('Editor did not complete; the plan and composer remain unchanged.')
    }
  } finally {
    if (!inTern && process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }
}

/** Always remove the private directory, even if the editor fails or is cancelled. */
export async function editPlanExternal(initial: string, opener: PlanOpener = openPlanFile): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-plan-'))

  try {
    const path = join(dir, 'plan.md')
    await writeFile(path, initial, { mode: 0o600 })
    await opener(path)

    return await readFile(path, 'utf8')
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}
