#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createGenerationAdapter } from './src/adapter.mjs';

try {
  const [command, sourcePath, hostPath, ...extra] = process.argv.slice(2);
  if (extra.length || !['prompt', 'compile'].includes(command) ||
      (command === 'compile' && (!sourcePath || !hostPath)) ||
      (command === 'prompt' && (sourcePath || hostPath))) {
    throw new Error('Usage: node cli.mjs prompt | compile <program.openui> <host-registry.json>');
  }
  const adapter = await createGenerationAdapter();
  if (command === 'prompt') process.stdout.write(`${adapter.prompt}\n`);
  else {
    const source = await readFile(sourcePath, 'utf8');
    const host = JSON.parse(await readFile(hostPath, 'utf8'));
    const context = { scope: host.scope, snapshots: new Map(Object.entries(host.snapshots)) };
    process.stdout.write(`${JSON.stringify(adapter.compile(source, context), null, 2)}\n`);
  }
} catch (error) {
  console.error(`${error.code ?? 'error'}: ${error.message}`);
  process.exitCode = 1;
}
