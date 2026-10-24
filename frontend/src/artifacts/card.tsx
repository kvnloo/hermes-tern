// A file tool's existing card gains session-owned links and verified native figures.
// The registry, tool parsers, diffs and source code remain the plugin's source of truth.

import type { ToolCall } from '../model.js'
import type { Card } from '../view/tools/types.js'
import { record } from '../wire/json.js'

import { fileHref, type FileContext } from './links.js'
import { confirmedWriteArtifact, writtenArtifactNode } from './written.js'

const fileTools = new Set(['read_file', 'patch', 'write_file'])

/** Decorate only file cards; never point a remote gateway path at a local editor. */
export function artifactCard(call: ToolCall, card: Card, context: FileContext): Card {
  if (!fileTools.has(call.name)) {
    return card
  }

  const result = record(call.result)
  const resolved = result?.['resolved_path']
  const specified = call.args['path'] ?? call.args['file_path']
  const path = typeof resolved === 'string' ? resolved : typeof specified === 'string' ? specified : card.target
  let href: string | undefined

  if (context.hostLocal && path) {
    const line = call.name === 'read_file' ? firstLine(result?.['content']) : undefined

    href = fileHref(path, context.cwd, line === undefined ? undefined : { line })
  }

  const base: Card = {
    ...card,
    ...(path ? { target: path } : {}),
    ...(href ? { href } : {})
  }

  if (call.name !== 'write_file') {
    return base
  }

  const confirmed = confirmedWriteArtifact(call, context.cwd, context.hostLocal)
  const figure = confirmed ? writtenArtifactNode(confirmed, context.media) : undefined

  if (!figure) {
    return base
  }

  const diff = result?.['diff']
  const content = call.args['content'] ?? call.args['contents']
  const hasDiffCard = typeof diff === 'string' && diff.length > 0 && !diff.startsWith('@@ -0,0 ')
  const extra = hasDiffCard && typeof content === 'string'
    ? [<code key="artifact-source" numbers text={content.replace(/\n$/, '')} />]
    : []

  return { ...base, body: [figure, ...card.body, ...extra], folded: false, preview: undefined }
}

/** First actual row of a numbered read; never a fabricated source range. */
function firstLine(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const match = /^ *([1-9]\d*)\|/m.exec(value)
  const line = match?.[1] ? Number(match[1]) : undefined

  return line !== undefined && Number.isSafeInteger(line) ? line : undefined
}
