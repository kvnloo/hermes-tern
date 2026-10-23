# Voice in Hermes for Tern

Port provenance: Hermes fork
[ui-tsp/LIVE-VOICE.md](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/LIVE-VOICE.md)
and [PUSH-TO-TALK.md](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/PUSH-TO-TALK.md).

**Dictation** stays owned by [alt-glitch/hermes-tern#71](https://github.com/alt-glitch/hermes-tern/pull/71):
its recorder, /voice on/off, Alt+V, STT partials and final-at-caret undo splice are
not duplicated here. This port adds separate opt-in **Live voice** via
Alt+Shift+V or /live. The shortcut opens a disclosure; only the user's
explicit Allow click may call voice.live.start. The gateway-machine mic,
Hermes STT, regular prompt pipeline and Hermes TTS power the conversation.
Automatic spoken turns never send or edit the typed composer draft.

Mute/Unmute, Barge in / silence reply, and Stop are session+lease-scoped.
Escape and Ctrl+C stop live voice, including a start still awaiting ACK.
Switching sessions stops the old lease. Gateway disconnect retires all
consent. An audio lease keeps Send disabled until authoritative idle, even
when a stop request fails. The backend owns physical device teardown.
Permission, provider and TTS errors are visible, never silently retried.

**Real hold-to-talk is unavailable in Tern SDK 0.1.0**: KeyDecoder
collapses CSI-u press/repeat/release into the same Space key. Alt+Shift+Space
is explanation only. Space, repeats, Vim keys and IME remain untouched.
There is no timer-based release, invented blur/capability, or faux hold.

Backend dependency: Hermes fork preview/tern-frontend implements
tui_gateway/methods_voice.py, tui_gateway/live_voice.py and
voice.live events. The Hermes source pinned by this plugin may lack those
methods; an unsupported RPC yields a visible activation failure, not
working live voice. No extra paid speech provider is installed.

## OMP verification (from frontend)

    bun run check
    bun x vitest run src/__tests__/liveVoice.test.ts src/__tests__/holdVoice.test.ts
    bun run bundle

After PR #71 lands, integrate its dictation-busy state with liveVoice's
admission guard without copying the recorder. For an opt-in physical
test with a compatible Hermes gateway: permission failure, automatic
speech/response, barge-in, mute/unmute, stop-during-start, session switch,
transport death, existing draft and Tern native Send/undo.
Headless tests cannot validate acoustic echo rejection or physical key-up.
