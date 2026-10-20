// Vendored from Ripple (https://github.com/kvnloo/ripple, MIT), src/fast-controls/message.ts at d160863.
// Unchanged but for this header: the fast-control schema and interaction model every Ripple renderer shares.

// An answer as a chat message, for surfaces whose only way back to the agent is the conversation
// (Tern's chat, a phone composer): one line a person reads in the transcript and a model maps back
// to its control. Surfaces with a structured channel (z0bridge's POST /intent) send the Intent itself.

import type { FastControl, Intent } from './schema.js'

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`

/** `Picked "Postgres" for: Which database? (db = postgres)`. */
export function intentText(control: FastControl, intent: Intent): string {
  const value = Array.isArray(intent.value) ? intent.value.join(',') : String(intent.value)
  const tail = `(${control.id} = ${value})`
  const label = intent.label ?? value

  switch (control.kind) {
    case 'confirm':
      return `${intent.value === 'confirm' ? 'Confirmed' : 'Declined'}: ${control.prompt} ${tail}`
    case 'slider':
      return `Set ${label} for: ${control.prompt} ${tail}`
    default:
      return `Picked ${quote(label)} for: ${control.prompt} ${tail}`
  }
}
