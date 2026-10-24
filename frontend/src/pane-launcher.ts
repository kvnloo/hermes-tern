// A new conversation pane uses the same Hermes interpreter, profile home, and Tern split
// convention as the existing subagent watcher. No conversation or profile text reaches a shell.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { hermesSplit } from './watch/spec.js'

type PaneProcess = (file: string, args: string[], options: { shell: false }) => Promise<unknown>

/**
 * Start the plugin's own 'hermes tern --resume <id>' in a sibling pane, with the current
 * session's folder. False means no local Tern pane/launcher is available; the durable child
 * remains resumable with the command shown in the transcript.
 */
export async function launchPane(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  execute: PaneProcess = promisify(execFile)
): Promise<boolean> {
  const split = hermesSplit(env, [], argv)

  if (!split) {
    return false
  }

  await execute('tern', ['split', split.pane, 'right', '--cwd', cwd, '--', ...split.command], { shell: false })

  return true
}
