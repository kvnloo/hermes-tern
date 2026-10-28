// The search_files tool's detail: what it looked for, where, and the files or lines it found.

import { list, num, objects, type Raw, text, texts } from './fields.js'

/** One matching line of a content search. */
export interface SearchMatch {
  /** The file, as the tool wrote it (empty when it named none). */
  path: string
  /** Its line number; 0 when the match names none. */
  line: number
  text: string
}

/** A bounded projection of Hermes' per-file count map. */
export interface SearchCounts {
  rows: { path: string; count: number }[]
  clipped: boolean
  invalid: boolean
}

const COUNT_LIMIT = 200

function readCounts(value: unknown): SearchCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rows: SearchCounts['rows'] = []
  let seen = 0
  let invalid = false
  for (const path in value) {
    if (!Object.hasOwn(value, path)) continue
    if (seen++ >= COUNT_LIMIT) return { rows, clipped: true, invalid }
    const n = Reflect.get(value, path)
    if (path && typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) rows.push({ path, count: n })
    else invalid = true
  }
  return { rows, clipped: false, invalid }
}

/** A `search_files` call, read once. */
export interface SearchDetail {
  tool: 'search_files'
  pattern: string | undefined
  /** The folder searched. */
  path: string | undefined
  /** Asked for file names (`target: 'files'`), not lines. */
  filesOnly: boolean
  /** The files a file search found; undefined when the result lists none. */
  files: string[] | undefined
  /** The lines a content search found; undefined when the result lists none. */
  matches: SearchMatch[] | undefined
  /** Hermes' already formatted path-grouped matches; it is not a structured match array. */
  matchesText: string | undefined
  countMode: boolean
  counts: SearchCounts | undefined
  countsMalformed: boolean
  resultPresent: boolean
  omitted: boolean
  /** The total the tool counted, which may pass what it listed. */
  total: number | undefined
  truncated: boolean
  totalLowerBound: boolean
}

export function searchDetail({ args, result }: Raw): SearchDetail {
  const matches = list(result?.['matches'])
  const total = num(result?.['total_count'])

  return {
    countMode: args['output_mode'] === 'count',
    counts: readCounts(result?.['counts']),
    countsMalformed: result?.['counts'] !== undefined && (!result['counts'] || typeof result['counts'] !== 'object' || Array.isArray(result['counts'])),
    files: list(result?.['files']) ? texts(result?.['files']) : undefined,
    filesOnly: args['target'] === 'files',
    matches: matches
      ? objects(matches).map(m => ({
          line: num(m['line']) ?? 0,
          path: text(m['path']) ?? '',
          text: typeof m['content'] === 'string' ? m['content'] : ''
        }))
      : undefined,
    matchesText: text(result?.['matches_text']),
    path: text(args['path']),
    pattern: text(args['pattern']),
    resultPresent: result !== undefined,
    omitted: typeof result?.['_omitted'] === 'string' && Boolean(result['_omitted']),
    tool: 'search_files',
    total: total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined,
    totalLowerBound: result?.['total_count_is_lower_bound'] === true,
    truncated: result?.['truncated'] === true
  }
}
