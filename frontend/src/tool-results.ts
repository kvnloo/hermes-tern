// Retained generic result strings: no file access, gateway calls or JSON serialization.
import type { Entry, ToolCall, TurnEntry } from './model.js'
import { batchOf, callApp } from './tools/bridge.js'
import { toolKeyOf } from './tools/detail.js'

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
      (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x206f) ? '�' : char
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

export interface RetainedResult { readonly call: ToolCall; readonly text: string; readonly turn: TurnEntry; readonly rev: number }

/** Snapshot a bounded number of results; identity and text are rechecked before every action. */
export function retainedResults(entries: readonly Entry[]): RetainedResult[] {
  const out: RetainedResult[] = []
  for (const entry of entries) {
    if (entry.kind !== 'turn') { continue }
    for (const block of entry.blocks) {
      if (block.kind !== 'tool') { continue }
      const text = retainedGenericText(block.call)
      if (text !== undefined) {
        out.push({ call: block.call, text, turn: entry, rev: entry.rev })
        if (out.length > RESULT_CANDIDATE_LIMIT) { out.shift() }
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
