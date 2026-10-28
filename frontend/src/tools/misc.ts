// The details of the smaller tools: execute_code, memory, the skill and todo tools, Tool Search's
// lookups, the pull request tools, and every tool drawn with the generic card (the process,
// browser, vision and image tools, manage_connections without links, and any unknown name).

import { record } from '../wire/json.js'

import { list, num, type Raw, text, texts } from './fields.js'

/** What the generic card (and the image card in it) reads of any call it draws. */
export interface GenericFields {
  /** The args' `query` and `url`: what the card's head names. */
  query: string | undefined
  url: string | undefined
  /** An image tool's `prompt` or `question`. */
  prompt: string | undefined
  question: string | undefined
  /** What a tool said of an image: the result's `analysis`, or its `text_summary`. */
  said: string | undefined
}

/** The tools with nothing of their own to read: only the generic card's fields. */
type Plain = 'browser' | 'image_generate' | 'list_pull_requests' | 'manage_connections' | 'other' | 'session_search' | 'vision_analyze'

/** A call of a tool with no detail of its own. `browser` is every `browser*` tool, and `other` any name no view takes. */
export type PlainDetail = { [T in Plain]: GenericFields & { tool: T } }[Plain]

/**
 * A `todo_list` call (or `todo`, its legacy name), read once: the list it writes, which the
 * transcript folds into the call's todos (the view reads those).
 */
export interface TodoDetail extends GenericFields {
  tool: 'todo_list'
  /** The args' `todos`: the whole list, or with `merge` a patch on the one before; undefined when not a list. */
  todos: unknown[] | undefined
  merge: boolean
}

/** A `process_manage` call (or `process`, its name before Hermes renamed it), read once. */
export interface ProcessDetail extends GenericFields {
  tool: 'process_manage'
  /** The action asked for (`wait`, `kill`…), as text: `undefined` when the args name none. */
  action: string
}

/** An `execute_code` call, read once. */
export interface EvalDetail {
  tool: 'execute_code'
  code: string | undefined
  /** What it printed: the result's `output`, or its `stdout`. */
  output: string | undefined
  /** What failed: the result's `error`, or its `stderr`. */
  error: string | undefined
  /** Hermes explicitly reported stdout truncation; false does not establish completeness. */
  stdoutTruncated: boolean
}

/** A `memory` call, read once. */
export interface MemoryDetail {
  tool: 'memory'
  action: string | undefined
  /** How full memory is, as the tool words it. */
  usage: string | undefined
}

/** A `skills_list` call, read once. */
export interface SkillsDetail {
  tool: 'skills_list'
  names: string[]
  /** What the tool said when it listed none. */
  message: string | undefined
}

/** A `skill_view` call, read once. */
export interface SkillDetail {
  tool: 'skill_view'
  name: string | undefined
  content: string | undefined
}

/** A Tool Search `tool_search` call, read once. */
export interface ToolSearchDetail extends GenericFields {
  tool: 'tool_search'
  /** The queries: the strings of the args' `queries`, or its one `queries` or `query`. */
  queries: string[]
}

/** A Tool Search `tool_describe` call, read once. */
export interface ToolDescribeDetail extends GenericFields {
  tool: 'tool_describe'
  /** The tools it read about. */
  names: string[]
}

interface PullRequestFields extends GenericFields {
  repository: string | undefined
  number: number | undefined
}

/** A `link_pull_request` or `unlink_pull_request` call, read once (the PR's `url` is a generic field). */
export type PullRequestDetail = (PullRequestFields & { tool: 'link_pull_request' }) | (PullRequestFields & { tool: 'unlink_pull_request' })

export function genericFields({ args, result }: Raw): GenericFields {
  return {
    prompt: text(args['prompt']),
    query: text(args['query']),
    question: text(args['question']),
    said: text(result?.['analysis']) ?? text(result?.['text_summary']),
    url: text(args['url'])
  }
}

/** The parser of a tool with nothing of its own. */
export function plainDetail<T extends Plain>(tool: T): (raw: Raw) => GenericFields & { tool: T } {
  return raw => ({ ...genericFields(raw), tool })
}

export function todoDetail(raw: Raw): TodoDetail {
  return { ...genericFields(raw), merge: raw.args['merge'] === true, todos: list(raw.args['todos']), tool: 'todo_list' }
}

export function processDetail(raw: Raw): ProcessDetail {
  return { ...genericFields(raw), action: String(raw.args['action']), tool: 'process_manage' }
}

/** A typed producer signal only; reject explicit malformed or contradictory counters. */
function stdoutTruncated(result: Raw['result']): boolean {
  if (!result || !Object.hasOwn(result, 'stdout_truncated') || result['stdout_truncated'] !== true) return false
  const counts = ['stdout_bytes_captured', 'stdout_bytes_total', 'stdout_bytes_omitted'] as const
  for (const key of counts) {
    const value = result[key]
    if (Object.hasOwn(result, key) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) return false
  }
  const readCount = (key: string): number | undefined => {
    const value = result[key]
    return Object.hasOwn(result, key) && typeof value === 'number' ? value : undefined
  }
  const captured = readCount('stdout_bytes_captured')
  const total = readCount('stdout_bytes_total')
  const omitted = readCount('stdout_bytes_omitted')
  if (total !== undefined && total === 0) return false
  if (omitted !== undefined && (omitted === 0 || (total !== undefined && omitted > total))) return false
  if (captured !== undefined && total !== undefined && captured >= total) return false
  if (captured !== undefined && total !== undefined && omitted !== undefined && captured + omitted !== total) return false
  return true
}

export function evalDetail({ args, result }: Raw): EvalDetail {
  return {
    code: text(args['code']),
    error: text(result?.['error']) ?? text(result?.['stderr']),
    output: text(result?.['output']) ?? text(result?.['stdout']),
    stdoutTruncated: stdoutTruncated(result),
    tool: 'execute_code'
  }
}

export function memoryDetail({ args, result }: Raw): MemoryDetail {
  return { action: text(args['action']), tool: 'memory', usage: text(result?.['usage']) }
}

export function skillsDetail({ result }: Raw): SkillsDetail {
  const skills = list(result?.['skills']) ?? []

  return {
    message: text(result?.['message']),
    names: skills.map(s => text(record(s)?.['name']) ?? text(s)).filter(n => n !== undefined),
    tool: 'skills_list'
  }
}

export function skillDetail({ args, result }: Raw): SkillDetail {
  return { content: text(result?.['content']), name: text(args['name']), tool: 'skill_view' }
}

export function toolSearchDetail(raw: Raw): ToolSearchDetail {
  const { args } = raw
  const queries = list(args['queries'])

  return {
    ...genericFields(raw),
    queries: queries ? queries.filter(q => typeof q === 'string') : texts([text(args['queries']) ?? text(args['query'])]),
    tool: 'tool_search'
  }
}

export function toolDescribeDetail(raw: Raw): ToolDescribeDetail {
  const names = raw.args['names']

  return { ...genericFields(raw), names: texts(Array.isArray(names) ? names : [names]), tool: 'tool_describe' }
}

/** The parser of `link_pull_request` or `unlink_pull_request`: the same fields, under either key. */
export function pullRequestDetail<T extends PullRequestDetail['tool']>(tool: T): (raw: Raw) => PullRequestFields & { tool: T } {
  return raw => ({ ...genericFields(raw), number: num(raw.args['number']), repository: text(raw.args['repository']), tool })
}
