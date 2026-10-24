// Native report sheets share the same owner, per-session fences, SDK overlay,
// clipboard and scroll container. Arbitrary output never grants inventory authority.
import type { ChatPorts } from './app/ports.js'
import type { Overlay } from './overlays/overlay.js'
import { openOperationalOverlay } from './overlays/operational.js'
import { operationalText, operationalView, type Report } from './reports.js'
import { rpc } from './wire/rpc.js'
import { readOperational } from './wire/side.js'

type Host = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'scroll' | 'session'>

export interface ReportTicket {
  readonly sid: string | null
  readonly epoch: number
  readonly sheet: Overlay
  readonly report: Report
}

export class OperationalSheets {
  readonly host: Host
  #sid: string | null = null
  #epoch = 0
  #sheet: Overlay | undefined

  constructor(host: Host) {
    this.host = host
  }

  adopt(sid: string | null) {
    if (this.#sid === sid) {
      return
    }

    this.#sid = sid
    this.#epoch++

    if (this.#sheet) {
      this.host.close(this.#sheet)
      this.#sheet = undefined
    }
  }

  /** Only the topmost, still-current overlay has key/copy/close authority. */
  owns(sheet: Overlay) {
    return this.#sheet === sheet &&
      this.host.overlays.includes(sheet) &&
      this.host.overlays.at(-1) === sheet &&
      this.host.session.ref.live === this.#sid
  }

  closed(sheet: Overlay) {
    if (this.#sheet === sheet) {
      this.#sheet = undefined
      this.#epoch++
    }
  }

  /** Claim the sheet before asynchronous work: a close fences its reply. */
  begin(title: string, sid: string | null): ReportTicket | undefined {
    this.adopt(sid)
    const top = this.host.overlays.at(-1)

    // The user cannot issue a typed slash beneath an approval/secret modal.
    // Programmatic late responses must not cover that prompt either.
    if (top?.modal && top !== this.#sheet) {
      return undefined
    }

    const report: Report = { title, text: '', status: 'loading' }
    const sheet = openOperationalOverlay(this, report)
    this.#sheet = sheet

    return { epoch: ++this.#epoch, report, sheet, sid }
  }

  #valid(ticket: ReportTicket): boolean {
    return ticket.epoch === this.#epoch &&
      ticket.sheet === this.#sheet &&
      this.host.overlays.includes(ticket.sheet) &&
      this.host.session.ref.live === ticket.sid &&
      this.#sid === ticket.sid
  }

  /** Update a still-owned report even when an approval later covers it. */
  finish(ticket: ReportTicket | undefined, text: string, status: Report['status'] = 'ready', scope?: string): boolean {
    if (!ticket || !this.#valid(ticket)) {
      return false
    }

    ticket.report.text = text
    ticket.report.status = status

    if (scope !== undefined) {
      ticket.report.scope = scope
    }

    this.host.changed()

    return true
  }

  withdraw(ticket: ReportTicket | undefined) {
    if (ticket && this.#valid(ticket)) {
      this.host.close(ticket.sheet)
    }
  }

  showText(title: string, text: string) {
    this.finish(this.begin(title, this.host.session.ref.live), text)
  }

  /** The real canonical tools.show RPC: read-only, not slash-output sniffing. */
  async showTools(arg = ''): Promise<void> {
    const sid = this.host.session.ref.live
    const ticket = this.begin('/tools' + (arg ? ' ' + arg : ''), sid)

    if (!ticket) {
      return
    }

    if (!sid) {
      this.finish(ticket, 'No active Hermes session.', 'unavailable')

      return
    }

    try {
      const result = await rpc(this.host.gw, 'tools.show', { session_id: sid })
      const sections = (result?.sections ?? []).filter(section => section.tools?.length)
      const lines = sections.map(section => `[${section.name}] ${section.tools.map(tool => tool.name).join(', ')}`)
      this.finish(ticket, lines.length ? [...lines, `Total: ${result?.total ?? 0} tools`].join('\n') : 'No tools available.')
    } catch {
      // Authentication text from thrown gateway errors must not enter the view.
      this.finish(ticket, 'Hermes tools report is unavailable.', 'unavailable')
    }
  }

  /** MCP and SSH inventory remain namespaced, backend-owned snapshots. */
  show(service: 'mcp' | 'ssh', argument: string) {
    const sid = this.host.session.ref.live
    const arg = argument.trim().toLowerCase()
    const view = operationalView(service, arg)
    const label = service.toUpperCase()
    // Unsupported arguments can be secrets: do not echo them, even in the title.
    const title = view ? '/' + service + (arg ? ' ' + arg : '') : label + ' management unavailable'
    const ticket = this.begin(title, sid)

    if (!ticket) {
      return
    }

    if (!sid) {
      this.finish(ticket, 'No active Hermes session. No inventory read was attempted.', 'unavailable')

      return
    }

    if (!view) {
      this.finish(ticket,
        label + ' management is unsupported in this native sheet. No command or mutation was sent.\n\n' +
          (service === 'ssh'
            ? 'Use /ssh list to inspect the configured target for this profile.'
            : 'Use /mcp list, /mcp status, /mcp tools or /mcp catalog for read-only inventory.'),
        'unsupported')

      return
    }

    ticket.report.text = 'Reading Hermes ' + label + ' inventory…'
    this.host.changed()

    void (async () => {
      try {
        const result = await readOperational(this.host.gw, sid, view)
        this.finish(ticket, operationalText(result), result.state, result.scope)
      } catch {
        this.finish(ticket, 'Hermes inventory service is unavailable. No connection or mutation was attempted.', 'unavailable')
      }
    })()
  }
}
