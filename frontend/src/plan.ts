// Revision-bound plan review, adapted from the Hermes ui-tsp frontend.
// Assistant Markdown is a review candidate; only plan.status confers backend authority.

import type { Entry } from './model.js'

export interface PlanSection {
  title: string
  level: number
  text: string
}

export interface Plan {
  text: string
  preamble: string
  sections: PlanSection[]
}

export interface PlanAnnotation {
  section: number
  text: string
}

export interface PlanRevision {
  id: string
  revision: number
  text: string
  annotations: PlanAnnotation[]
  decision: 'pending' | 'approved' | 'refined'
}

export interface PlanStatus {
  enabled: boolean
  generating: boolean
  plan: PlanRevision | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate even canonical replies: older plugin-compatible gateways may lack the plan contract. */
export function planStatusOf(value: unknown): PlanStatus | undefined {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean' || typeof value['generating'] !== 'boolean') {
    return undefined
  }

  const rawPlan = value['plan']
  let plan: PlanRevision | null = null

  if (rawPlan !== null) {
    if (!isRecord(rawPlan)) {
      return undefined
    }

    const id = rawPlan['id']
    const revision = rawPlan['revision']
    const text = rawPlan['text']
    const decision = rawPlan['decision']
    const rawNotes = rawPlan['annotations']

    if (
      typeof id !== 'string' || !id ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof text !== 'string' ||
      (decision !== 'pending' && decision !== 'approved' && decision !== 'refined') ||
      !Array.isArray(rawNotes)
    ) {
      return undefined
    }

    const annotations: PlanAnnotation[] = []

    for (const note of rawNotes) {
      if (!isRecord(note)) {
        return undefined
      }

      const section = note['section']
      const noteText = note['text']

      if (typeof section !== 'number' || !Number.isSafeInteger(section) || section < 0 || typeof noteText !== 'string') {
        return undefined
      }

      annotations.push({ section, text: noteText })
    }

    plan = { annotations, decision, id, revision, text }
  }

  return { enabled: value['enabled'], generating: value['generating'], plan }
}

/** Backend plans do not need headings. */
export function reviewPlanText(text: string): Plan {
  return parsePlan(text) ?? { preamble: '', sections: [{ level: 1, text, title: 'Plan' }], text }
}

/** Markdown headings in fenced code are never table-of-contents entries. */
export function parsePlan(text: string): Plan | undefined {
  const headings: { title: string; level: number; offset: number }[] = []
  let fence: { marker: string; length: number } | undefined
  let offset = 0

  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}((?:\x60{3,}|~{3,}))(.*)$/)

    if (fence) {
      if (marker && marker[1]?.[0] === fence.marker && marker[1].length >= fence.length && !marker[2]?.trim()) {
        fence = undefined
      }
    } else if (marker) {
      fence = { length: (marker[1]?.length ?? 0), marker: (marker[1]?.[0] ?? '') }
    } else {
      const heading = line.match(/^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/)

      if (heading) {
        headings.push({
          level: (heading[1]?.length ?? 0),
          offset,
          title: (heading[2] ?? '').replace(/[\t ]+#+[\t ]*$/, '')
        })
      }
    }

    offset += line.length + 1
  }

  if (!headings.length) {
    return undefined
  }

  return {
    preamble: text.slice(0, (headings[0]?.offset ?? 0)),
    sections: headings.map((heading, index) => ({
      level: heading.level,
      text: text.slice(heading.offset, headings[index + 1]?.offset ?? text.length),
      title: heading.title
    })),
    text
  }
}

/** Ignore user text, tool output, reasoning and unfinished assistant turns. */
export function latestPlan(entries: readonly Entry[]): Plan | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]

    if (entry?.kind !== 'turn' || entry.end.status !== 'done') {
      continue
    }

    const plan = parsePlan(
      entry.blocks
        .filter(block => block.kind === 'text')
        .map(block => block.text)
        .join('\n\n')
    )

    if (plan) {
      return plan
    }
  }

  return undefined
}
