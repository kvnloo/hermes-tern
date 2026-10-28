import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodeJson } from '../wire/json.js'

describe('plain-text history after a fresh process', () => {
  it('treats legacy and newly persisted shell-looking entries as literal', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-history-literal-'))
    const file = join(home, '.hermes_history')
    const env = { PATH: process.env['PATH'] ?? '', HOME: home, HERMES_HOME: home }
    try {
      writeFileSync(file, '\n# legacy\n+!echo legacy\n')
      execFileSync('bun', ['--eval', `
        const { Composer } = await import('./src/draft/composer.ts');
        const c = new Composer();
        c.paste('Review {!echo pasted}\\n!echo tail');
        c.take();
        c.set('!echo typed');
        c.take();
      `], { cwd: process.cwd(), env })
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('# legacy\n+!echo legacy')
      expect(content).toContain('+Review {!echo pasted}\n+!echo tail')
      expect(content).toContain('+!echo typed')
      const output = execFileSync('bun', ['--eval', `
        const { Composer } = await import('./src/draft/composer.ts');
        const { typedCommands } = await import('./src/hermes/shell.ts');
        const c = new Composer();
        const up = { name: 'up', alt: false, ctrl: false, meta: false, shift: false };
        const seen = [];
        for (let i = 0; i < 3; i++) {
          if (i === 2) c.key(up); // Move to the first line before leaving the multiline entry.
          c.key(up);
          seen.push({ text: c.text, literal: c.literal, protected: c.shellPasted.includes(c.text), commands: typedCommands(c.text, c.shellPasted).length });
        }
        console.log(JSON.stringify(seen));
      `], { cwd: process.cwd(), env, encoding: 'utf8' })
      expect(decodeJson(output)).toEqual([
        { text: '!echo typed', literal: true, protected: true, commands: 0 },
        { text: 'Review {!echo pasted}\n!echo tail', literal: true, protected: true, commands: 0 },
        { text: '!echo legacy', literal: true, protected: true, commands: 0 }
      ])
    } finally {
      rmSync(home, { force: true, recursive: true })
    }
  })
})
