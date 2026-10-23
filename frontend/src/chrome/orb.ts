// Geometry adapted from OMP Handsfree's Cairo ThinkingOrb (voice_orb.py).
// Agent state comes from Hermes events. Only the image animates, never the transcript.
import type { ImageProps, Session, Surface } from '@stencil-hq/tern'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

export type OrbState = 'idle' | 'working' | 'thinking' | 'composing' | 'listening' | 'speaking' | 'waiting' | 'error'

/** Presentation of the owning agent, not an estimate of progress. */
export class OrbActivity {
  #phase: OrbState = 'idle'
  #voice: OrbState = 'idle'
  #active = false
  readonly #tools = new Set<string>()

  reset(running = false) {
    this.#phase = running ? 'working' : 'idle'
    this.#active = running
    this.#voice = 'idle'
    this.#tools.clear()
  }

  state(waiting = false): OrbState {
    if (waiting) {
      return 'waiting'
    }

    if (this.#phase === 'error' || this.#voice === 'error') {
      return 'error'
    }

    if (this.#voice === 'listening' || this.#voice === 'speaking') {
      return this.#voice
    }

    if (this.#tools.size) {
      return 'working'
    }

    // App-side shell expansion and prompt admission are not confirmed agent activity.
    return this.#phase === 'idle' ? this.#voice : this.#phase
  }

  event(ev: AnyGatewayEvent) {
    if (
      !this.#active &&
      (ev.type === 'reasoning.delta' ||
        ev.type === 'reasoning.available' ||
        ev.type === 'thinking.delta' ||
        ev.type === 'message.delta' ||
        ev.type === 'message.interim' ||
        ev.type === 'tool.generating' ||
        ev.type === 'tool.start')
    ) {
      return
    }

    switch (ev.type) {
      case 'message.start':
        this.#active = true
        this.#phase = 'working'
        this.#tools.clear()

        break

      case 'reasoning.delta':

      case 'reasoning.available':

      case 'thinking.delta':
        this.#phase = 'thinking'

        break

      case 'message.delta':

      case 'message.interim':
        this.#phase = 'composing'

        break

      case 'tool.generating':
        this.#phase = 'working'

        break

      case 'tool.start':
        if (ev.payload) {
          this.#tools.add(ev.payload.tool_id)
        }

        this.#phase = 'working'

        break

      case 'tool.complete':
        if (ev.payload) {
          this.#tools.delete(ev.payload.tool_id)
        }

        break

      case 'message.complete':
        this.#active = false
        this.#phase = ev.payload?.status === 'error' ? 'error' : 'idle'
        this.#tools.clear()

        break

      case 'error':

      case 'gateway.start_timeout':

      case 'gateway.protocol_error':
        this.#active = false
        this.#phase = 'error'
        this.#tools.clear()

        break
      case 'voice.status': {
        const phase = ev.payload?.state
        this.#voice =
          phase === 'listening' || phase === 'recording' || phase === 'captured'
            ? 'listening'
            : phase === 'speaking' || phase === 'playing' || phase === 'tts'
              ? 'speaking'
              : phase === 'transcribing'
                ? 'thinking'
                : phase === 'error'
                  ? 'error'
                  : 'idle'

        break
      }

      default:
        // This is a partial event projector: unrelated gateway events never change the orb.
        return
    }
  }
}

const NODE_ID = 'dock.composer.line.orb'
const FRAMES = 96
const FPS = 12

/** Finite cached SVG frames; no new blobs after a state's first animation cycle. */
export class ThinkingOrb {
  readonly #tern: Session
  readonly #surface: Surface
  readonly #frames = new Map<string, string>()
  #state: OrbState = 'idle'
  #frame = 0
  #dark: boolean
  #reduce: boolean
  #visible = true
  #paused = false
  #closed = false
  #timer: NodeJS.Timeout | undefined

  constructor(tern: Session, surface: Surface) {
    this.#tern = tern
    this.#surface = surface
    this.#dark = Boolean(tern.caps.dark)
    this.#reduce = Boolean(tern.caps.reduceMotion)
  }

  update(state: OrbState, paused = false) {
    if (this.#closed) {
      return
    }

    if (state !== this.#state) {
      this.#state = state
      this.#frame = 0
    }

    this.#paused = paused
    this.#sync()
  }

  environment(options: { dark?: boolean; reduce?: boolean; visible?: boolean }) {
    if (this.#closed) {
      return
    }

    this.#dark = options.dark ?? this.#dark
    this.#reduce = options.reduce ?? this.#reduce
    this.#visible = options.visible ?? this.#visible

    if (this.#reduce) {
      this.#frame = 0
    }

    this.#sync()
  }

  props(): ImageProps {
    return { blob: this.#blob(), alt: `Hermes agent: ${this.#state}`, w: 34, h: 34 }
  }

  close() {
    this.#closed = true
    this.#stop()
  }

  #stop() {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  #sync() {
    const run =
      this.#visible &&
      !this.#reduce &&
      !this.#paused &&
      this.#state !== 'idle' &&
      this.#state !== 'waiting' &&
      this.#state !== 'error' &&
      !this.#surface.closed

    if (!run) {
      this.#stop()
    } else if (!this.#timer) {
      this.#timer = setInterval(() => {
        if (this.#surface.closed) {
          this.#stop()

          return
        }

        // Skip blocked frames rather than growing the SDK's raw-op queue.
        if (this.#surface.blocked) {
          return
        }

        this.#frame = (this.#frame + 1) % FRAMES
        this.#surface.send([['set', NODE_ID, { blob: this.#blob() }]])
      }, 1000 / FPS)
      this.#timer.unref()
    }
  }

  #blob(): string {
    const key = `${this.#dark}:${this.#state}:${this.#frame}`
    let blob = this.#frames.get(key)

    if (!blob) {
      blob = this.#tern.blob(
        Buffer.from(orbSvg(this.#state, (this.#frame / FRAMES) * Math.PI * 2, this.#dark)),
        'image/svg+xml'
      )
      this.#frames.set(key, blob)
    }

    return blob
  }
}

/** Same disc, orbit particles, listening rings and ribbon as the OMP live voice control. */
// t is the normalized cycle angle; integer harmonics make the cached wrap continuous.
export function orbSvg(state: OrbState, t: number, dark: boolean): string {
  const ink = dark ? '#f5f5fa' : '#24212b'
  const dim = dark ? '#b8bdc7' : '#68616e'
  const disc = dark ? '#17121f' : '#f5f1f8'

  const ring =
    state === 'error'
      ? '#ef5754'
      : state === 'listening'
        ? '#5ad8e6'
        : state === 'waiting'
          ? '#e5b95b'
          : state === 'idle'
            ? dark
              ? '#382e47'
              : '#cec3d8'
            : '#ed4abf'

  const out: string[] = []
  const n = (v: number) => v.toFixed(2)

  const circle = (x: number, y: number, r: number, color: string, opacity = 1, stroke = 0) => {
    out.push(
      `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" ${stroke ? `fill="none" stroke="${color}" stroke-width="${n(stroke)}"` : `fill="${color}"`} opacity="${n(opacity)}"/>`
    )
  }

  const path = (points: [number, number][], color: string, opacity: number, width: number) => {
    out.push(
      `<path d="${points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round" opacity="${n(opacity)}"/>`
    )
  }

  const cx = 17,
    cy = 17,
    outer = 15.5,
    radius = outer * 0.72

  circle(cx, cy, outer, disc)
  circle(cx, cy, outer - 0.8, ring, state === 'idle' ? 1 : 0.85, 1.6)

  if (state === 'idle' || state === 'waiting') {
    circle(cx, cy, radius * 0.22, ink, 0.92)
    circle(cx, cy, radius * 0.48, dim, 0.7, 1.3)
    circle(cx, cy, radius * 0.72, dim, 0.4, 1.1)
  } else if (state === 'error') {
    const d = radius * 0.28
    path(
      [
        [cx - d, cy - d],
        [cx + d, cy + d]
      ],
      ring,
      0.95,
      1.8
    )
    path(
      [
        [cx - d, cy + d],
        [cx + d, cy - d]
      ],
      ring,
      0.95,
      1.8
    )
  } else if (state === 'listening') {
    for (let i = 0; i < 3; i++) {
      circle(
        cx,
        cy,
        radius * (0.34 + 0.2 * i + 0.12 * (0.5 + 0.5 * Math.sin(t * (2 + i) + i * 0.7))),
        ink,
        0.9 - i * 0.2,
        1.5
      )
    }

    circle(cx, cy, radius * 0.12, ink, 0.95)
  } else if (state === 'working' || state === 'thinking') {
    const orbits = state === 'working' ? 3 : 2
    const particles = state === 'working' ? 9 : 6
    const speed = state === 'working' ? 2 : 1

    for (let o = 0; o < orbits; o++) {
      const r = radius * (0.32 + 0.22 * o)
      circle(cx, cy, r, dim, 0.35, 1)

      for (let p = 0; p < particles; p++) {
        const a = t * (speed + o) + (p * Math.PI * 2) / particles + o * 0.4
        circle(
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          Math.max(1.2, radius * (0.08 + (p % 3) * 0.025)),
          ink,
          0.95 - o * 0.12
        )
      }
    }

    circle(cx, cy, radius * 0.1, ink, 0.9)
  } else {
    for (let i = 0; i < 3; i++) {
      const phase = t * (1 + i) + i * 0.85
      const points: [number, number][] = []

      for (let s = 0; s <= 36; s++) {
        const u = s / 36,
          a = u * Math.PI * 2 + phase

        const r = radius * (0.34 + 0.18 * i + 0.12 * Math.sin(u * Math.PI * 4 + phase))
        points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * (0.78 + 0.08 * i)])
      }

      path(points, ink, 0.85 - i * 0.18, 1.8)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="68" height="68" viewBox="0 0 34 34">${out.join('')}</svg>`
}
