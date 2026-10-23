// Display strings are projections only: never feed them back into link resolution.
import { stripVTControlCharacters } from 'node:util'

export function displayText(text: string): string {
  // Keep layout whitespace; make remaining C0/C1 and bidi overrides visible.
  // eslint-disable-next-line no-control-regex -- make control bytes visible in displayed text
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function displayOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : displayText(text)
}
