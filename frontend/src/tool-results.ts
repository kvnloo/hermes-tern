// Retained generic and fetched page text: no file access or gateway calls.
import type { Entry, ToolCall, TurnEntry } from './model.js'
import { batchOf, callApp } from './tools/bridge.js'
import { resultOf, toolKeyOf } from './tools/detail.js'
import { record } from './wire/json.js'

export const RESULT_PREVIEW_LIMIT = 4000
export const RESULT_CANDIDATE_LIMIT = 80
export const RESULT_PAGE_LIMIT = 256

/** Do not pass terminal control or bidirectional formatting characters to the renderer. */
export function safeResultText(text: string): string {
  return Array.from(text, char => {
    const point = char.codePointAt(0) ?? 0
    return (point < 32 && point !== 9 && point !== 10) ||
      (point >= 127 && point <= 159) || (point >= 0xd800 && point <= 0xdfff) ||
      point === 0x061c || point === 0x200e || point === 0x200f ||
      (point >= 0x2028 && point <= 0x202e) || (point >= 0x2066 && point <= 0x206f) ? '�' : char
  }).join('')
}

/** Only values already used by the generic card; this does not reconstruct upstream output. */
export function retainedGenericText(call: ToolCall): string | undefined {
  if (call.outcome.kind === 'running' || toolKeyOf(call.name) !== 'other' || callApp(call) || batchOf(call)) {
    return undefined
  }
  const text = call.resultText ?? (typeof call.result === 'string' ? call.result : undefined)
  return text && text.length > RESULT_PREVIEW_LIMIT ? text : undefined
}

export interface RetainedResult {
  readonly call: ToolCall
  readonly text: string
  readonly turn: TurnEntry
  readonly rev: number
  /** The exact returned entry, if this is a web extraction rather than a generic result. */
  readonly web?: { readonly index: number; readonly ordinal: number; readonly row: unknown; readonly result: unknown }
}

/** Read a pinned-producer object row without repeatedly parsing nested JSON strings. */
function webPage(call: ToolCall, index: number): { row: unknown; text: string } | undefined {
  if (call.name !== 'web_extract' || call.outcome.kind === 'running') return undefined
  const rows = resultOf(call)?.['results']
  if (!Array.isArray(rows)) return undefined
  const row: unknown = rows[index]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const value = record(row)?.['content']
  return typeof value === 'string' && value.length > RESULT_PREVIEW_LIMIT ? { row, text: value } : undefined
}

/** Whether a Fetch card has an inspectable page under the same eligibility rules. */
export function hasRetainedWeb(call: ToolCall): boolean {
  if (call.name !== 'web_extract' || call.outcome.kind === 'running') return false
  const rows = resultOf(call)?.['results']
  return Array.isArray(rows) && rows.some((_, index) => webPage(call, index) !== undefined)
}

/** Revalidate the precise page and the result owner before any action or display. */
export function retainedResultText(candidate: RetainedResult): string | undefined {
  if (!candidate.web) return retainedGenericText(candidate.call)
  if (candidate.call.result !== candidate.web.result) return undefined
  const page = webPage(candidate.call, candidate.web.index)
  return page && page.row === candidate.web.row ? page.text : undefined
}

/** Snapshot a bounded number of results; identity and text are rechecked before every action. */
export function retainedResults(entries: readonly Entry[]): RetainedResult[] {
  const out: RetainedResult[] = []
  let webOrdinal = 0
  for (const entry of entries) {
    if (entry.kind !== 'turn') { continue }
    for (const block of entry.blocks) {
      if (block.kind !== 'tool') { continue }
      const call = block.call
      const add = (candidate: RetainedResult) => {
        out.push(candidate)
        if (out.length > RESULT_CANDIDATE_LIMIT) { out.shift() }
      }
      const text = retainedGenericText(call)
      if (text !== undefined) add({ call, text, turn: entry, rev: entry.rev })
      if (call.name !== 'web_extract') continue
      const ordinal = ++webOrdinal
      if (call.outcome.kind === 'running') continue
      const rows = resultOf(call)?.['results']
      if (!Array.isArray(rows)) continue
      for (let index = 0; index < rows.length; index++) {
        const page = webPage(call, index)
        if (page) add({ call, text: page.text, turn: entry, rev: entry.rev,
          web: { index, ordinal, result: call.result, row: page.row } })
      }
    }
  }
  return out
}

/** One bounded grapheme-safe page; undefined if a single grapheme exceeds the bound. */
export function resultPage(text: string, start: number): { text: string; end: number } | undefined {
  if (start < 0 || start >= text.length) { return undefined }
  const limit = RESULT_PREVIEW_LIMIT
  const part = text.slice(start, start + limit + 512)
  const complete = start + part.length === text.length
  let end = 0
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part)) {
    const next = segment.index + segment.segment.length
    if (next > limit || (!complete && next === part.length)) { break }
    end = next
  }
  if (!end) { return undefined }
  // Plain text, never ANSI/OSC or bidi control. Preserve line breaks and tabs.
  const safe = safeResultText(part.slice(0, end))
  return { end: start + end, text: safe }
}
