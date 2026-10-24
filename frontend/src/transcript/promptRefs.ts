// What a stored prompt carried, apart from the words the user wrote. Hermes persists an attached
// image as an `@image:<path>` line (tui_gateway/session_history.py), a native-vision turn as
// `[Image attached at: <path>]` hints plus one `[screenshot]` placeholder per image (the store's
// text-only projection), and `@file:` references expanded under `--- Attached Context ---`. The
// desktop lifts these out of the bubble (apps/desktop/src/lib/chat-messages/hydration.ts,
// lib/embedded-images.ts); so does this, keeping the attachments to show beside the words.

import { existsSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import type { UserAttachment } from '../model.js'

/** A reference's value: bare, or quoted with backticks, double or single quotes. */
const VALUE = '(`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|\\S+)'
const IMAGE_SUFFIX = new RegExp('^@image:' + VALUE + '$')
// The native-vision suffix: a blank line, the hints, then the placeholders (none, or one each).
const HINTS = /\n\n((?:\[Image attached(?: at)?: [^\n]+\]\n?)+)((?:\[screenshot\](?:\n|$))*)$/
const ATTACHED_CONTEXT = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS = /(?:^|\n)--- Context Warnings ---[\s\S]*$/
// The head line of each attached reference, as agent/context_references.py writes it (`📄 @file:…`).
const CONTEXT_REF = new RegExp(`^(?:\\S+ )?@(file|folder|url|image):${VALUE}`, 'gm')
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

const unquote = (v: string) => (/^([`"']).*\1$/.test(v) ? v.slice(1, -1) : v)

/** A stored prompt split into the words to show and what it carried. */
export interface PromptParts {
  text: string
  /** Image paths (or URLs, for a remote image), in order. */
  images: string[]
  /** Files the attached context expanded, as referenced, with the disk path an image file gives. */
  files: { ref: string; path?: string }[]
}

/** Splits a stored user row into its words and its attachments. */
export function splitPrompt(raw: string): PromptParts {
  let text = raw
  let hinted: string[] = []

  const hints = HINTS.exec(text)

  if (hints) {
    const paths = [...(hints[1] ?? '').matchAll(/^\[Image attached(?: at)?: (?<path>.+)\]$/gm)].flatMap(m => m.groups?.['path'] ?? [])
    const placeholders = (hints[2] ?? '').split('[screenshot]').length - 1

    if (placeholders === 0 || placeholders === paths.length) {
      text = text.slice(0, hints.index)
      hinted = paths
    }
  }

  // Only the canonical persisted terminal absolute-path suffix is attachment metadata.
  // Python's splitlines() accepts a single terminal LF/CRLF; preserve all earlier lines.
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const row = (i: number) => (lines[i] ?? '').replace(/\r$/, '')
  let last = lines.length
  while (last > 0 && row(last - 1) === '[screenshot]') last--
  const placeholders = lines.length - last
  let first = last
  const refs: string[] = []
  while (first > 0) {
    const match = IMAGE_SUFFIX.exec(row(first - 1))
    const path = match?.[1] ? unquote(match[1]) : undefined
    if (!path || !isAbsolute(path)) break
    refs.unshift(path)
    first--
  }

  // Do not consume terminal lines inside a fenced literal example.
  let fence: { mark: string; count: number } | undefined
  for (let i = 0; i < first; i++) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row(i))
    if (!delimiter?.[1]) continue
    if (!fence) {
      fence = { mark: delimiter[1][0] ?? '', count: delimiter[1].length }
    } else if (delimiter[1][0] === fence.mark && delimiter[1].length >= fence.count && !delimiter[2]?.trim()) {
      fence = undefined
    }
  }

  if (!fence && refs.length && (!placeholders || placeholders === refs.length)) {
    text = lines.slice(0, first).join('\n')
  } else {
    refs.length = 0
  }

  const files: PromptParts['files'] = []
  const marker = ATTACHED_CONTEXT.exec(text)

  if (marker) {
    const context = text.slice(marker.index + marker[0].length)
    text = text.slice(0, marker.index)

    for (const m of context.matchAll(CONTEXT_REF)) {
      const ref = `@${m[1]}:${m[2]}`
      const end = context.indexOf('\n', m.index)
      const line = context.slice(m.index, end < 0 ? undefined : end)
      const disk = /available on disk at `([^`]+)`/.exec(line)?.[1]

      // A ref the words still hold shows there; only the ones they lost are listed.
      if (!text.includes(ref) && !files.some(f => f.ref === ref)) {
        files.push({ ref, ...(disk ? { path: disk } : {}) })
      }
    }
  }

  return { files, images: [...refs, ...hinted], text: text.replace(CONTEXT_WARNINGS, '').replace(/\n{3,}/g, '\n\n').trim() }
}

/** A stored prompt's attachments, each image with its file when that is still on disk. */
export function promptAttachments(parts: PromptParts, exists: (path: string) => boolean = existsSync): UserAttachment[] {
  const local = (p: string) => p.startsWith('/') && exists(p)

  return [
    ...parts.images.map(p => ({
      kind: 'image' as const, name: basename(p), refPath: p,
      ...(local(p) ? { source: { path: p } } : {})
    })), 
    ...parts.files.map(({ path, ref }): UserAttachment => {
      const name = basename(unquote(ref.replace(/^@\w+:/, '')))

      // Only @image: histories are authorized by media.image without a tool ID.
      return path && IMAGE_FILE.test(path) && local(path)
        ? { kind: 'image', name, source: { path } }
        : { kind: 'file', name }
    })
  ]
}
