// The pinned Hermes gateway's supported, normalized config.get/config.set words.
// There is no schema, arbitrary path setter, credential setter, or profile CAS at 22063fc.
// Keep this allowlist narrower than the gateway and never call config.get key='full'.
export type PreferenceKind = 'choice' | 'switch' | 'text'

export interface Preference {
  readonly key: string
  readonly label: string
  readonly group: string
  readonly hint: string
  readonly kind: PreferenceKind
  readonly options?: readonly string[]
  /** A change of security policy requires separate affirmative confirmation. */
  readonly consequential?: boolean
}

export const PROFILE_PREFERENCES: readonly Preference[] = [
  { key: 'busy', label: 'While Hermes is busy', group: 'Agent', hint: 'Persistent default for new prompts. Live turns keep their current admission policy.', kind: 'choice', options: ['queue', 'steer', 'interrupt'] },
  { key: 'approvals.mode', label: 'Approval policy', group: 'Safety', hint: 'Profile-wide tool approvals; changing the policy affects future actions and requires explicit confirmation.', kind: 'choice', options: ['manual', 'smart', 'off'], consequential: true },
  { key: 'details_mode', label: 'Tool detail', group: 'Display', hint: 'Default collapsed or expanded tool details for Hermes.', kind: 'choice', options: ['collapsed', 'expanded'] },
  { key: 'thinking_mode', label: 'Thought display', group: 'Display', hint: 'Default thought rendering in Hermes.', kind: 'choice', options: ['collapsed', 'truncated', 'full'] },
  { key: 'theme', label: 'Hermes TUI theme', group: 'Display', hint: 'Hermes profile theme; not the local Tern surface theme set by /theme.', kind: 'choice', options: ['auto', 'light', 'dark'] },
  { key: 'density', label: 'Compact Hermes TUI', group: 'Display', hint: 'Persistent Hermes TUI density; Tern layout remains native.', kind: 'switch', options: ['off', 'on'] },
  { key: 'focus', label: 'Focus view', group: 'Display', hint: 'Profile focus mode. Enabling it also updates the canonical tool-progress setting.', kind: 'switch', options: ['off', 'on'] },
  { key: 'skin', label: 'Hermes skin', group: 'Display', hint: 'Profile skin name. Use /theme skin to display it in this Tern pane.', kind: 'text' }
]

export function preference(key: string): Preference | undefined {
  return PROFILE_PREFERENCES.find(field => field.key === key)
}

/** No unknown config keys or unvalidated free-form choices cross the wire. */
export function preferenceValue(field: Preference, value: unknown): string {
  if (field.kind === 'switch' && typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }

  if (typeof value !== 'string' || (field.kind === 'text' && (!value.trim() || value.length > 128))) {
    throw new Error('Enter a nonempty value (at most 128 characters for a skin).')
  }

  if (field.kind !== 'text' && !field.options?.includes(value)) {
    throw new Error('Choose a value provided by Hermes.')
  }

  return value
}

/** Renderer-only projection. Canonical reads stay in Hermes, not in plugin settings.json. */
export interface ProfileRow {
  field: Preference
  value: string
}
