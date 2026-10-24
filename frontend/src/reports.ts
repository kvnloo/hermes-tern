// Report routes are explicit; an unknown MCP/SSH management verb never becomes
// a read or a gateway slash dispatch.
import type { OperationalReport, OperationalView } from './wire/side.js'

export interface Report {
  title: string
  text: string
  status: 'loading' | 'ready' | 'unavailable' | 'unsupported'
  scope?: string | undefined
}

const ROUTES: readonly { service: 'mcp' | 'ssh'; arg: string; view: OperationalView }[] = [
  { service: 'mcp', arg: '', view: 'mcp-list' },
  { service: 'mcp', arg: 'list', view: 'mcp-list' },
  { service: 'mcp', arg: 'status', view: 'mcp-status' },
  { service: 'mcp', arg: 'tools', view: 'mcp-tools' },
  { service: 'mcp', arg: 'catalog', view: 'mcp-catalog' },
  { service: 'ssh', arg: '', view: 'ssh-list' },
  { service: 'ssh', arg: 'list', view: 'ssh-list' }
]

export function operationalView(service: string, arg: string): OperationalView | undefined {
  return ROUTES.find(item => item.service === service.toLowerCase() && item.arg === arg.trim().toLowerCase())?.view
}

/** Markdown text from inventory values is always literal, never a server-authored link. */
function literal(text: string) {
  return text.replace(/([\\\x60*_{}[\]()#+.!|<>~-])/g, '\\$1').replace(/\r?\n/g, ' ')
}

export function operationalText(result: OperationalReport): string {
  const empty = result.view === 'ssh-list'
    ? 'No SSH hosts configured in this Hermes profile.'
    : result.view === 'mcp-catalog'
      ? 'No MCP catalog entries available.'
      : 'No MCP servers configured in this Hermes profile.'

  return [
    literal(result.message),
    ...result.rows.map(row =>
      '## ' + literal(row.name) + '\n\n' + row.details.map(detail => '- ' + literal(detail)).join('\n')
    ),
    ...(result.state === 'ready' && result.rows.length === 0 ? [empty] : [])
  ].join('\n\n')
}

/** Explicitly supported report forms, never a guess from backend output. */
export function isReportCommand(name: string, argument: string): boolean {
  const command = name.toLowerCase()
  const arg = argument.trim().toLowerCase()

  if (command === 'status') {
    return arg === ''
  }

  if (command === 'tools') {
    return arg === '' || arg === 'list'
  }

  if (command === 'mcp' || command === 'ssh') {
    return operationalView(command, arg) !== undefined
  }

  return command === 'usage' || command === 'context' || command === 'history' || command === 'help'
}
