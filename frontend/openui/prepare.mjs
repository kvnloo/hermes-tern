#!/usr/bin/env node
// Explicit prepare-only entrypoint for the unmodified reviewed donor CLI.
// No dependency install, renderer installation, control input or publication.
const args = process.argv.slice(2)

if (args.length !== 6 || args[0] !== 'prepare' || args[5] !== '--json') {
  console.error('Usage: node openui/prepare.mjs prepare <program.openui> <host-document.json> <scope-json> <output-dir> --json')
  process.exitCode = 1
} else {
  // The real @openuidev/lang-core parser is used, with telemetry off before
  // its module is imported. The donor's own strict static checks still apply.
  process.env.OPENUI_TELEMETRY_DISABLED = '1'
  process.env.DO_NOT_TRACK = '1'
  await import('./openui-preview/cli.mjs')
}
