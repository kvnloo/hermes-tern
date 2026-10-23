// Read-only operational inventory. Hermes owns scope, MCP and SSH authority;
// this feature never probes, installs, connects, authenticates or mutates.
import type { ChatPorts } from './app/ports.js'
import type { Overlay } from './overlays/overlay.js'
import { openOperationalOverlay } from './overlays/operational.js'
import { operationalText, operationalView, type Report } from './reports.js'
import { readOperational } from './wire/side.js'

type Host = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'scroll' | 'session'>

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

  show(service: 'mcp' | 'ssh', argument: string) {
    const sid = this.host.session.ref.live

    if (!sid) {
      return
    }

    this.adopt(sid)
    const arg = argument.trim().toLowerCase()
    const view = operationalView(service, arg)
    const label = service.toUpperCase()
    const report: Report = view
      ? { title: '/' + service + (arg ? ' ' + arg : ''), text: 'Reading Hermes ' + label + ' inventory…', status: 'loading' }
      : {
          title: label + ' management unavailable',
          status: 'unsupported',
          text: label + ' management is unsupported in this native sheet. No command or mutation was sent.\n\n' +
            (service === 'ssh'
              ? 'Use /ssh list to inspect the configured target for this profile.'
              : 'Use /mcp list, /mcp status, /mcp tools or /mcp catalog for read-only inventory.')
        }
    const epoch = ++this.#epoch
    const sheet = openOperationalOverlay(this, report)
    this.#sheet = sheet

    if (!view) {
      return
    }

    void (async () => {
      try {
        const result = await readOperational(this.host.gw, sid, view)

        if (this.#epoch !== epoch || this.#sheet !== sheet || !this.host.overlays.includes(sheet) ||
            this.host.session.ref.live !== sid) {
          return
        }

        report.status = result.state
        report.scope = result.scope
        report.text = operationalText(result)
      } catch {
        if (this.#epoch !== epoch || this.#sheet !== sheet || !this.host.overlays.includes(sheet) ||
            this.host.session.ref.live !== sid) {
          return
        }

        // Never display raw gateway exceptions: authentication headers can appear there.
        report.status = 'unavailable'
        report.text = 'Hermes inventory service is unavailable. No connection or mutation was attempted.'
      }

      this.host.changed()
    })()
  }
}
