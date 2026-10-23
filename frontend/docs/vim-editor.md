# Optional Vim composer and external editor

This plugin reuses the tested Hermes `ui-tsp` Vim contract and the OMP-inspired
modal editor (Can Bölük / Stencil Labs, MIT). Hermes retains ownership of
session settings, history and prompt submission. The Tern SDK owns the native
editor view, not a second text model.

## Enable and disable

Vim is **off by default**. In the owning Hermes profile:

```sh
hermes config set display.vim_mode true
```

Reattach/start a session to refresh `config.get full` and its
`display.vim_mode`. Set it to `false` to return to Tern's ordinary editing
on the next adopt. The plugin does **not** write this setting to its own
`settings.json`. Reads from a stale session cannot change the current mode.

## Editing

Insert mode begins with ordinary text editing; Escape enters Normal. The modal
subset includes grapheme-aware `h j k l`, `0 ^ $ w b e gg G`, counts,
`i a I A o O`, `v V`, `d c y` with motions or doubled line operators,
`x D C r p P u Ctrl+R`. Visual selection is inclusive. The Vim yank register
is local to this composer, not the system clipboard.

Overlays, completion, Ctrl+C and attachments retain their established key
priority. A paste is literal text, one undo step, and keeps its pasted-command
provenance so `!cmd` and `{!cmd}` cannot be executed as typed input. Native
Tern edit/send/undo callbacks are ignored only while Vim is enabled. The dock
shows the current native editor mode and any pending command.

This is an intentional subset, not full Vim: search, text objects, macros,
repeat-dot, named registers, indentation operators, and continuous Replace mode
are not supported.

## External editor

`/editor` round-trips the draft through a private temporary file (0600),
then removes it. In a Tern native window, `tern open --wait` opens the file.
In an ordinary terminal it suspends the surface, invokes `$VISUAL`, `$EDITOR`,
or `vi` with **argv** (no shell interpretation), and resumes the surface.
Failures preserve the draft. If a session switches or the draft changes while
editing, the returned text appears in an informational transcript panel instead
of overwriting newer work. One editor per composer may be open at a time.

## Qualification

From this repository's `frontend/` directory:

```sh
bun run setup
bunx vitest run src/__tests__/vim.test.ts src/__tests__/vimPreference.test.ts src/__tests__/externalEditor.test.ts src/__tests__/vimApp.test.ts src/__tests__/keys.test.ts
bun run check
bun run bundle
```

Tests were authored but **not executed** by the connector-only port worker.
OMP must record actual results and check a real isolated Tern native window:
IME candidate windows, Unicode/emoji selection, mode and anchor rendering,
editor cancel/replace, Native-vs-keyboard send/undo, suspend/resume, and
no-TSP/Ink fallback. This file is not a claim of native acceptance.

Source provenance: `kvnloo/hermes-agent` branch `preview/tern-frontend`,
`ui-tsp/VIM.md`, `src/vim.ts`, `src/vim-preference.ts`,
`src/external-editor.ts`; OMP `packages/tui/src/vim.ts` and
`packages/tui/src/prompt/custom-editor.ts`, pinned
`eb74cf84d8e16ac9b8c4fa5d7c43037023d016ac`.
