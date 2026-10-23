// Only a proven same-host Hermes session may turn LSP paths into Tern file targets.
// Adapted from Hermes ui-tsp/src/links.ts (preview/tern-frontend, MIT);
// Tern/Stencil owns opening the file. Never probe the filesystem.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { LspRange } from '../../tools/lsp-result.js'

export interface LspLinkContext {
  readonly cwd: string
  readonly hostLocal: boolean
}

/** Inputs come from the live frame, never a result payload or the frontend process cwd. */
export interface LspHostEvidence {
  readonly cwd: string | null | undefined
  readonly terminalBackend: string | null | undefined
  readonly sessionLive: boolean
  readonly gatewayAttached: boolean
  readonly ssh: boolean
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function safePath(path: string): boolean {
  return Boolean(path.trim()) && !SCHEME.test(path) && !path.startsWith('//') &&
    !Array.from(path).some(char => {
      const code = char.charCodeAt(0)

      return code < 32 || code === 127
    })
}

/** Unknown backend, attached gateway, SSH, missing session or cwd all refuse local links. */
export function lspLinkContext(evidence: LspHostEvidence): LspLinkContext {
  const cwd = typeof evidence.cwd === 'string' && isAbsolute(evidence.cwd) && safePath(evidence.cwd)
    ? evidence.cwd
    : ''

  return {
    cwd,
    hostLocal: Boolean(cwd && evidence.sessionLive && evidence.terminalBackend === 'local' &&
      evidence.gatewayAttached === false && !evidence.ssh)
  }
}

/** Donor-compatible file URLs and #L10-L20 / #L10C3 anchors, without disk access. */
export function lspFileHref(path: string, context?: LspLinkContext, range?: LspRange): string | undefined {
  if (!context?.hostLocal || !isAbsolute(context.cwd) || !safePath(context.cwd) || !safePath(path)) {
    return undefined
  }

  try {
    const url = pathToFileURL(isAbsolute(path) ? path : resolve(context.cwd, path))

    if (range && Number.isSafeInteger(range.start.line) && range.start.line > 0 &&
        Number.isSafeInteger(range.start.col) && range.start.col > 0) {
      const end = Number.isSafeInteger(range.end.line) && range.end.line > range.start.line
        ? '-L' + range.end.line
        : 'C' + range.start.col
      url.hash = 'L' + range.start.line + end
    }

    return url.href
  } catch {
    return undefined
  }
}
