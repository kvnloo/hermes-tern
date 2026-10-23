// Conservative, bounded presentation pass. Tables and model history are immutable.
export interface NumericTable {
  readonly source: string
  readonly labels: readonly string[]
  readonly values: readonly number[]
  readonly title: string
}
export type ChartKind = 'bar' | 'line' | 'none'
export type ChartMode = 'off' | 'always' | 'smart'
export interface TableSlice { readonly start: number; readonly end: number; readonly table: NumericTable }
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())

export function analyzeTable(source: string): NumericTable | undefined {
  if (source.length > 8192 || /[\\`<>]/.test(source) || [...source].some(c => c !== '\n' && c.charCodeAt(0) < 32)) { return }
  const rows = source.trim().split('\n').map(cells)
  const [header, delimiter, ...body] = rows

  if (!header || header.length !== 2 || header.some(s => !s) || !delimiter || delimiter.length !== 2 ||
      !delimiter.every(s => /^:?-{3,}:?$/.test(s)) || body.length < 2 || body.length > 24 ||
      body.some(row => row.length !== 2 || !row[0] || NUMBER.test(row[0]) || !NUMBER.test(row[1] ?? ''))) { return }

  const labels = body.map(row => row[0] ?? '')
  const raw = body.map(row => row[1] ?? '')
  const values = raw.map(s => Number(s.replace(/%$/, '')))

  if (new Set(labels).size !== labels.length || labels.some(s => s.length > 80) ||
      new Set(raw.map(s => s.endsWith('%'))).size !== 1 || values.some(n => !Number.isFinite(n) || Math.abs(n) > 1e12) ||
      values.every(n => n === 0)) { return }

  return Object.freeze({ source, labels: Object.freeze(labels), values: Object.freeze(values), title: header[1] ?? '' })
}

/** Only top-level pipe tables outside fenced code; bound each complete Markdown block. */
export function tableSlices(markdown: string): TableSlice[] {
  if (markdown.length > 65536) { return [] }
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? []
  const result: TableSlice[] = []
  let offset = 0
  let fence = ''

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

    if (marker) {
      if (!fence) { fence = marker } else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = '' }
    } else if (!fence && /^ {0,3}\|/.test(line) && /^ {0,3}\|/.test(lines[i + 1] ?? '')) {
      let source = line
      let end = i + 1

      while (end < lines.length && /^ {0,3}\|/.test((lines[end] ?? ''))) { source += lines[end] ?? ''
        end++ }
      const table = analyzeTable(source)

      if (table && result.length < 8) { result.push({ start: offset, end: offset + source.length, table }) }
      offset += source.length
      i = end - 1

      continue
    }

    offset += line.length
  }

  return result
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\x60': '&#96;'
}
const xml = (s: string) => s.replace(/[&<>"'\x60]/g, c => XML_ENTITIES[c] ?? c)

/** Unresolved terminal semantic tokens follow host palette changes without re-planning. */
export function chartSvg(table: NumericTable, kind: Exclude<ChartKind, 'none'>): string {
  const min = Math.min(0, ...table.values)
  const max = Math.max(0, ...table.values)
  const scale = (n: number) => 260 - (n - min) / (max - min) * 210
  const baseline = scale(0)
  const step = 500 / table.values.length
  const points = table.values.map((n, i) => `${60 + (i + 0.5) * step},${scale(n)}`).join(' ')

  const marks = kind === 'line'
    ? `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="3"/>`
    : table.values.map((n, i) => `<rect x="${60 + i * step + 4}" y="${Math.min(baseline, scale(n))}" width="${step - 8}" height="${Math.max(1, Math.abs(baseline - scale(n)))}" fill="var(--accent)"/>`).join('')

  const labels = table.labels.map((s, i) => `<text x="${60 + (i + 0.5) * step}" y="285" text-anchor="middle" fill="var(--text)" font-size="10">${xml(s.slice(0, 12))}</text>`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="320" viewBox="0 0 620 320"><title>${xml(table.title)}</title><text x="60" y="25" fill="var(--text)" font-size="16">${xml(table.title)}</text><text x="5" y="55" fill="var(--muted)" font-size="10">${max}</text><text x="5" y="260" fill="var(--muted)" font-size="10">${min}</text><path d="M60 ${baseline}H560" stroke="var(--muted)"/>${marks}${labels}</svg>`
}

interface CachedChart { kind: ChartKind; pending?: Promise<void> }
export interface ChartPlanner {
  policy(session: string): Promise<ChartMode>
  plan(session: string, table: NumericTable): Promise<ChartKind>
}

/** A per-App derived cache, never an authoritative transcript or settings store. */
export class TableCharts {
  mode: ChartMode = 'off'
  revision = 0
  #session = ''
  #generation = 0
  #budget = 8
  #active = false
  #cache = new Map<string, CachedChart>()
  constructor(private readonly planner: ChartPlanner, private readonly changed: () => void) {}

  session(session: string) {
    if (this.#session === session) { return }
    this.#session = session
    this.configure('off')
    this.#cache.clear()
    this.#budget = 8
    const generation = this.#generation

    if (session) {
      void this.planner.policy(session).then(mode => {
        if (generation === this.#generation) { this.configure(mode) }
      }, () => undefined)
    }
  }

  configure(mode: ChartMode) {
    const changed = this.mode !== mode || this.#cache.size > 0
    this.mode = mode
    this.#generation++
    this.#active = false
    this.#cache.clear()

    if (changed) { this.revision++; this.changed() }
  }

  close() { this.#generation++; this.#session = ''; this.#cache.clear() }

  markdown(source: string, settled: boolean): string {
    if (!settled || this.mode === 'off') { return source }
    const slices = tableSlices(source)
    let result = ''
    let offset = 0

    for (const { end, table } of slices) {
      result += source.slice(offset, end)
      offset = end
      const key = table.source.trimEnd()
      let entry = this.#cache.get(key)

      if (!entry) {
        if (this.#cache.size >= 128) {
          const oldest = this.#cache.keys().next().value

          if (oldest !== undefined) { this.#cache.delete(oldest) }
        }
        entry = { kind: 'bar' }
        this.#cache.set(key, entry)

        if (this.mode === 'smart' && this.#budget > 0 && !this.#active) { this.#plan(table, entry) }
      }

      if (entry.kind !== 'none') { result += `\n\n\`\`\`svg\n${chartSvg(table, entry.kind)}\n\`\`\`\n\n` }
    }

    return result + source.slice(offset)
  }

  #plan(table: NumericTable, entry: CachedChart) {
    this.#budget--
    this.#active = true
    const generation = this.#generation
    entry.pending = this.planner.plan(this.#session, table).then(kind => {
      if (generation === this.#generation) { entry.kind = kind }
    }, () => undefined).finally(() => {
      if (generation !== this.#generation) { return }
      this.#active = false
      this.revision++
      this.changed()
    })
  }
}
