// Convert Hermes's session-local paths into links Tern can open in a native file block.
// No filesystem probing: only Tern decides whether a target exists or can be opened.

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { displayText } from './display-text.js'

export interface FileLinkOptions {
  line?: number
  endLine?: number
  col?: number
}

const scheme = /^[a-z][a-z0-9+.-]*:/i

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** No implicit process cwd: relative links must belong to an identified Hermes session. */
export function fileHref(path: string, cwd: string, opts: FileLinkOptions = {}): string | undefined {
  // Control bytes cannot be meaningful local file-link targets.
  const hasControl = Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

  if (!path || !path.trim() || hasControl || scheme.test(path) || path.startsWith('//')) {
    return undefined
  }

  if (!isAbsolute(path) && !isAbsolute(cwd)) {
    return undefined
  }

  try {
    const url = pathToFileURL(isAbsolute(path) ? path : resolve(cwd, path))
    const line = positive(opts.line)
    const end = positive(opts.endLine)
    const col = positive(opts.col)

    // Tern routes file:// links. Line fragments follow #L10 / #L10-L20;
    // column support (#L10C3) still requires native host confirmation.
    if (line) {
      url.hash = 'L' + line + (end && end > line ? '-L' + end : col ? 'C' + col : '')
    }

    return url.href
  } catch {
    return undefined
  }
}

/** A Markdown destination is a path, optionally with a source-line anchor. */
function markdownFileTarget(target: string, cwd: string): string | undefined {
  if (!target || target.startsWith('#')) {
    return undefined
  }

  const anchored = /^(.*)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i.exec(target)
  const plain = anchored?.[1] ?? target
  let path: string

  try {
    // Markdown URLs often percent-encode spaces; decode just once before
    // pathToFileURL encodes the canonical file URL. Invalid escapes stay unchanged.
    path = decodeURIComponent(plain)
  } catch {
    return undefined
  }

  if (!anchored) {
    return fileHref(path, cwd)
  }

  const line = Number(anchored[2])

  return fileHref(path, cwd, anchored[3] ? { line, endLine: Number(anchored[3]) } : { line })
}

/** Odd preceding backslashes escape a Markdown delimiter. */
function escaped(line: string, at: number): boolean {
  let n = 0

  for (let i = at - 1; i >= 0 && line[i] === '\\'; i--) {
    n++
  }

  return n % 2 === 1
}

/** Read one Markdown inline link without taking over images or reference links. */
function linkAt(line: string, at: number): { destStart: number; close: number } | undefined {
  let depth = 1
  let labelEnd = at + 1

  while (labelEnd < line.length && depth) {
    if (!escaped(line, labelEnd)) {
      if (line[labelEnd] === '[') {depth++}
      else if (line[labelEnd] === ']') {depth--}
    }

    if (depth) {labelEnd++}
  }

  if (depth || line[labelEnd + 1] !== '(') {
    return undefined
  }

  const destStart = labelEnd + 2
  let close = destStart
  let parentheses = 0

  while (close < line.length) {
    if (!escaped(line, close)) {
      if (line[close] === '(') {parentheses++}
      else if (line[close] === ')') {
        if (!parentheses) {break}
        parentheses--
      }
    }

    close++
  }

  return close < line.length ? { destStart, close } : undefined
}

/** Resolve inline links while keeping code spans and image targets literal. */
function rewriteLine(line: string, cwd: string, safeDisplay = false): string {
  let output = ''
  let ticks = 0
  let i = 0

  while (i < line.length) {
    if (line.charCodeAt(i) === 96 && !escaped(line, i)) {
      let end = i + 1

      while (line.charCodeAt(end) === 96) {
        end++
      }

      const count = end - i

      if (!ticks) {ticks = count}
      else if (ticks === count) {ticks = 0}

      output += line.slice(i, end)
      i = end

      continue
    }

    if (ticks || line[i] !== '[' || escaped(line, i) || (i > 0 && line[i - 1] === '!')) {
      output += line[i++]

      continue
    }

    const link = linkAt(line, i)

    if (!link) {
      output += line[i++]

      continue
    }

    const raw = line.slice(link.destStart, link.close)
    const angle = raw.startsWith('<') && raw.endsWith('>')
    const dest = angle ? raw.slice(1, -1) : raw
    const href = (angle || !/\s/.test(dest)) ? markdownFileTarget(dest, cwd) : undefined

    if (safeDisplay && displayText(dest) !== dest) {
      // Unsafe raw destinations stay inert, not links to a sanitized different file.
      output += line.slice(i + 1, link.destStart - 2) + ' (' + displayText(dest) + ')'
    } else if (!href) {
      output += line.slice(i, link.close + 1)
    } else {
      // Parentheses in a file URL need an angle destination for Markdown.
      const safe = /[()]/.test(href) ? '<' + href + '>' : href
      output += line.slice(i, link.destStart) + safe + ')'
    }

    i = link.close + 1
  }

  return output
}

/** Resolve assistant prose against its real session cwd, never Tern's process cwd. */
function markdownLinks(markdown: string, cwd: string, safeDisplay = false): string {
  if ((!isAbsolute(cwd) && !safeDisplay) || !markdown.includes('](')) {
    return markdown
  }

  let fence: { mark: string; length: number } | undefined

  return (markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => {
    const opening = /^ {0,3}([\x60]{3,}|~{3,})/.exec(line)

    if (fence) {
      const closing = /^ {0,3}([\x60]{3,}|~{3,})\s*$/.exec(line)

      if (closing && closing[1]?.[0] === fence.mark && closing[1].length >= fence.length) {
        fence = undefined
      }

      return line
    }

    if (opening?.[1]) {
      fence = { mark: opening[1][0] ?? '', length: opening[1].length }

      return line
    }

    // Indented code is not prose either.
    return /^(?: {4}|\t)/.test(line) ? line : rewriteLine(line, cwd, safeDisplay)
  }).join('')
}

export function rewriteLocalMarkdownLinks(markdown: string, cwd: string): string {
  return markdownLinks(markdown, cwd)
}

/** Resolve raw destinations first; sanitize only the presentation, never retarget a link. */
export function displayMarkdown(markdown: string, cwd: string): string {
  return displayText(markdownLinks(markdown, cwd, true))
}

/** File abilities of one shown Hermes session, never of the Tern process itself. */
export interface FileContext {
  cwd: string
  hostLocal: boolean
  media: boolean
}

export const NO_FILE_CONTEXT: FileContext = { cwd: '', hostLocal: false, media: false }

/** SSH makes the host Tern renders on different from the frontend process. */
export function ternSharesFrontendHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env['SSH_CONNECTION'] && !env['SSH_CLIENT'] && !env['SSH_TTY']
}
