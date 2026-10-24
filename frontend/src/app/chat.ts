// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one frame of the whole view (app/frame.ts); the SDK diffs it into
// frame ops. App is the composition root: it makes the stores (app/stores.ts)
// and the actions over them (app/actions.ts), lends them as ChatPorts, and
// runs the pane until it quits.

import type { ScrollTo, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import logo from '../../assets/logo.png'
import type { BtwThreads } from '../btw.js'
import type { Agents } from '../agents/store.js'
import type { Sidebar } from '../chrome/sidebar.js'
import { sessionHost } from '../commands/host.js'
import type { SessionHost } from '../commands/session.js'
import { type LaunchEnv, readLaunchEnv } from '../config/env.js'
import { markViewer } from '../connections/cards.js'
import { errorText } from '../core/errors.js'
import { durable, entryId, type PrKey, type StoredSessionId } from '../core/ids.js'
import { RenderScheduler } from '../core/scheduler.js'
import { onKey } from '../draft/keys.js'
import { editExternal as editDraftExternal } from '../draft/external-editor.js'
import { followGateway } from '../gateway/follow.js'
import type { PullRequests } from '../github/store.js'
import { HostLifecycle } from '../host-lifecycle.js'
import type { NoticeEntry } from '../model.js'
import type { OperationalSheets } from '../operations.js'
import { openHelp } from '../overlays/help.js'
import type { Overlay } from '../overlays/overlay.js'
import type { Cron } from '../processes/cron.js'
import type { Processes } from '../processes/store.js'
import type { Automation } from '../session/automation.js'
import { applyEffort } from '../session/effort.js'
import { forgetPane } from '../session/pane.js'
import type { SessionState } from '../session/state.js'
import { fileSettings, type SettingsSource, type ThemeMode } from '../settings.js'
import { onTernEvent } from '../surface/actions.js'
import { INPUT_ID, SurfaceHost } from '../surface/host.js'
import { runInput } from '../surface/input.js'
import type { Transcript } from '../transcript/store.js'
import type { Busy } from '../turn/activity.js'
import { IMAGE_ONLY_PROMPT } from '../turn/prompt.js'
import { Retention } from '../view/retention.js'
import { STYLES } from '../view/styles.js'
import { noticeSink, onCardFault } from '../view/tools/faults.js'
import { busyLabel, preparingLabel } from '../view/workLogModel.js'

import { AppActions } from './actions.js'
import { drawFrame, type FrameCx } from './frame.js'
import type { ChatPorts } from './ports.js'
import { type ChatStores, chatStores, disposeStores } from './stores.js'

/** How long quitting waits for the sessions to detach. */
const QUIT_DETACH_MS = 1500

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements ChatPorts {
  // The stores the ports lend (ChatPorts; app/stores.ts says what each one holds).
  readonly session: SessionState
  readonly transcript: Transcript
  readonly agents: Agents
  readonly processes: Processes
  readonly cron: Cron
  readonly btw: BtwThreads
  readonly operations: OperationalSheets
  readonly sidebar: Sidebar
  readonly automation: Automation
  readonly prs: PullRequests
  readonly overlays: Overlay[]
  /** Every store, the ports' among them: entry.ts and the tests reach the rest here, a module through its ports. */
  readonly stores: ChatStores
  readonly #renders = new RenderScheduler(() => this.#frame())
  #done = Promise.withResolvers<number>()
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #launch: LaunchEnv
  readonly #hostLifecycle: HostLifecycle
  /** What the user starts and the stores call back into, bound once. */
  readonly #act: AppActions
  #surface!: SurfaceHost
  #editingExternal = false
  #retention: Retention | undefined
  /** What each frame draws from (app/frame.ts); set once run() opened the surface. */
  #view: FrameCx | undefined

  /** `launch` and `settings` are what entry.ts read once at startup; unset, each reads its default. */
  constructor(tern: Session, gw: GatewayClient, version: string, { launch = readLaunchEnv(), settings = fileSettings(), writeHost }: { launch?: LaunchEnv; settings?: SettingsSource; writeHost?: (text: string) => void } = {}) {
    this.#tern = tern
    this.#gw = gw
    this.#launch = launch
    this.#hostLifecycle = new HostLifecycle(writeHost ?? (text => {
      if (launch.pane) {
        process.stdout.write(text)
      }
    }))
    const s = chatStores(this, { act: () => this.#act, gw, launch, settings, surface: () => this.#surface, tern, version })
    this.stores = s
    this.session = s.session
    this.transcript = s.transcript
    this.agents = s.agents
    this.processes = s.processes
    this.cron = s.cron
    this.btw = s.btw
    this.operations = s.operations
    this.sidebar = s.sidebar
    this.automation = s.automation
    this.prs = s.prs
    this.overlays = s.overlays
    this.#act = new AppActions({ ...s, chat: this, gw, launch, surface: () => this.#surface, tern })
  }

  /** The running turn (or a send's `{!cmd}`s), null when idle. */
  get busy(): Busy | null {
    return this.stores.activity.busy
  }

  /** The gateway, for overlays that issue their own RPCs. */
  get gw(): GatewayClient {
    return this.#gw
  }

  /** Whose colors the surface wears (`/theme`). */
  get theme(): ThemeMode {
    return this.stores.theme.mode
  }

  async run(): Promise<number> {
    const s = this.stores
    this.#surface = new SurfaceHost(this.#tern, 'hermes', STYLES, {
      changed: () => this.changed(),
      recovered: surface => {
        // The new document uses the same stores, transcript, held requests and draft.
        this.#retention = this.#tern.caps.features.includes('settle')
          ? new Retention(surface, () => this.changed(), () => ({ entries: this.transcript.entries, lifetime: this.transcript.lifetime }))
          : undefined
        if (this.#view) {
          this.#view = { ...this.#view, retention: this.#retention }
        }
        this.#surface.guardHandlers(Boolean(this.#retention))
        this.#guardOverlayHandlers()
      },
      report: message => {
        process.stderr.write('hermes tern: ' + message + '\n')
        this.transcript.notice(message, 'error')
        this.changed()
      }
    })
    if (this.#tern.caps.features.includes('settle')) {
      this.#retention = new Retention(this.#surface.raw, () => this.changed(), () => ({ entries: this.transcript.entries, lifetime: this.transcript.lifetime }))
    }
    this.#surface.guardHandlers(Boolean(this.#retention))
    this.#guardOverlayHandlers()
    this.#view = {
      ...s,
      actions: this.#act.dock,
      aside: () => this.#tern.caps.features.includes('aside'),
      copies: this.#act,
      gateway: this.#gw,
      surface: this.#surface,
      retention: this.#retention
    }
    s.theme.apply()
    // A card that throws draws as the generic one, and the pane says so once per tool name.
    onCardFault(noticeSink(text => this.notice(text, 'warning')))

    if (this.#tern.caps.features.includes('blobs')) {
      s.welcome.logo = this.#tern.blob(logo, 'image/png')
    }

    this.transcript.push({ id: entryId('welcome'), kind: 'welcome' })

    // `hermes -q …`: the launcher's query is the first prompt, sent literally once the first session is adopted.
    const query = this.#launch.query

    if (query || s.attachments.awaitingStartup) {
      s.queue.hold({ images: [], kind: 'app', text: query || IMAGE_ONLY_PROMPT })
    }

    followGateway(this.#gw, {
      ...s,
      drain: () => s.queue.drain(),
      eventLog: this.#launch.eventLog,
      gw: this.#gw,
      hostLifecycle: this.#hostLifecycle,
      labels: { busy: busyLabel, preparing: preparingLabel },
      reportCwd: () => this.#act.reportCwd(),
      request: req => this.#act.onRequest(req),
      setCompacting: on => this.#act.setCompacting(on),
      showImage: call => this.#act.showImage(call),
      showArtifacts: call => this.#act.showArtifacts(call),
      sid: () => this.session.ref.live,
      summarize: delay => this.#act.summarize(delay)
    })
    this.processes.poke()
    this.#frame()
    this.#surface.focus(INPUT_ID)
    // Keys and Tern events until the pane closes, each followed by a render; then the app quits.
    void runInput(this.#tern, {
      after: () => this.changed(),
      onError: error => this.#surface.failure(new Error(`Tern input failed: ${errorText(error)}`)),
      onEvent: event => {
        if (this.#surface.event(event)) {
          this.#retention?.gone(event)
          if (this.stores.stack.nativeReceipt(event).allowed) {
            onTernEvent(event, this.#act.events)
          }
        }
      },
      onKey: key => {
        if (this.#surface.state !== 'visible') {
          return
        }
        if (this.#retention && key.ctrl && key.name === 'home' && !this.overlays.at(-1)?.modal) {
          this.#retention.request(true)
        } else {
          onKey(key, this.#act.keys, this.overlays.at(-1))
        }
      }
    }).then(() => this.#end())

    const code = await this.#done.promise
    // Bounded, as Ink's deferExitForClose: a dead socket must not hold the terminal.
    await Promise.race([s.life.leaveAll('tui_shutdown'), new Promise(resolve => s.timers.timeout(() => resolve(undefined), QUIT_DETACH_MS))])
    this.dispose()
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
  }

  /**
   * Stops what the pane runs on its own: every timer, the stores' polls and the sidebar's reads.
   * Quitting calls it once the sessions detached (or the wait gave up), before Tern closes.
   */
  dispose() {
    this.#surface?.dispose()
    this.#act.dispose()
    disposeStores(this.stores)
  }

  /** One frame of the whole view, once run() opened the surface. */
  #frame() {
    if (!this.#view || this.#surface.closed) {
      return
    }
    try {
      drawFrame(this.#view)
      this.#surface.rendered()
    } catch (error) {
      this.#surface.failure(error)
    }
  }

  /**
   * SurfaceHost already fences document epochs. Fence the separate overlay
   * open-instance namespace before native SDK lookup and again when a bound
   * callback executes (a replacement can occur between these two moments).
   */
  #guardOverlayHandlers() {
    const surface = this.#surface.raw
    const dispatch = surface.dispatch.bind(surface)

    surface.dispatch = event => {
      const receipt = this.stores.stack.nativeReceipt(event)

      if (!receipt.allowed) {
        return undefined
      }

      const handler = dispatch(event)

      return handler && (() => {
        if (this.stores.stack.ownsNativeReceipt(receipt)) {
          return handler()
        }
      })
    }
  }

  open(overlay: Overlay) {
    this.stores.stack.open(overlay)
  }

  close(overlay: Overlay) {
    this.stores.stack.close(overlay)
  }

  changed() {
    if (this.session && this.stores) {
      this.#hostLifecycle.project({
        sid: this.session.ref.live,
        working: this.busy !== null || Boolean(this.stores.activity.compacting),
        submitting: this.stores.queue.count() > 0,
        waiting: this.overlays.some(o => o.key.startsWith('prompt:'))
      })
    }

    this.#renders.request()
  }

  /** A notice in the transcript, rendered now. */
  notice(text: string, tone?: NoticeEntry['tone']) {
    this.transcript.notice(text, tone)
    this.changed()
  }

  /** An error nothing caught (a rejected promise no caller awaited): shown, so the pane lives on. */
  fault(reason: unknown) {
    this.notice(`Unexpected error: ${errorText(reason)}`, 'error')
  }

  attachClipboardImage(quiet: boolean): Promise<void> {
    return this.stores.attachments.fromClipboard(quiet)
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  attachImagePath(raw: string): Promise<void> {
    return this.stores.attachments.fromPath(raw)
  }

  toggleSidebar() {
    this.#act.toggleSidebar()
  }

  reveal(id: string) {
    this.#surface.reveal(id, 'start')
  }

  scroll(id: string, to: ScrollTo) {
    this.#surface.scroll(id, to)
  }

  openPrAside(key: PrKey | undefined) {
    this.#act.openPrAside(key)
  }

  openAgent(id: string): Promise<void> {
    return this.#act.openAgent(id)
  }

  openHelp(): Promise<void> {
    return openHelp(this, this.#act.bindings.actions)
  }

  openPalette(): void {
    this.#act.openPalette()
  }

  /** /editor: native Tern file or $VISUAL/$EDITOR in a suspended terminal. */
  async editExternal(): Promise<void> {
    if (this.#editingExternal || !this.#surface || this.#surface.closed) return
    this.#editingExternal = true
    const grid = !process.env['TERN_WINDOW_KEY']
    try {
      if (grid) this.#surface.suspend()
      await editDraftExternal({
        composer: this.stores.composer,
        sid: () => this.session.ref.live,
        changed: () => this.changed(),
        notice: (text, tone) => this.notice(text, tone),
        panel: (title, text) => this.transcript.panel(title, text)
      })
    } finally {
      if (grid && !this.#surface.closed) this.#surface.resume()
      this.#editingExternal = false
      this.changed()
    }
  }

  /** The user quits (Ctrl+C twice, Ctrl+D, /quit): a later `hermes tern` in this pane starts a new session. */
  quit(code = 0) {
    forgetPane(this.#launch)
    this.#end(code)
  }

  /**
   * The app ends. Input that stops on its own (the pane closed, a signal) ends it here and keeps the
   * pane's session, which `hermes tern` resumes if it starts again in the pane.
   */
  #end(code = 0) {
    this.#hostLifecycle.project({ sid: null, waiting: false, working: false })
    markViewer(null, durable(this.session.ref))
    this.#done.resolve(code)
  }

  control(): SessionHost {
    return sessionHost(this.#act.host)
  }

  newSession(title?: string): Promise<void> {
    return this.stores.life.newSession(title)
  }

  resume(id: StoredSessionId): Promise<void> {
    return this.stores.life.resume(id)
  }

  setTheme(mode: ThemeMode) {
    this.stores.theme.set(mode)
    this.changed()
  }

  setEffort(value: string, scope: 'global' | 'session'): Promise<void> {
    return applyEffort(this, value, scope)
  }
}
