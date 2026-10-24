import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControl, parseReply, capturePreview as rawCapturePreview, readShot, FOCUSED_SURFACE as SURFACE } from '../src/control.mjs';
import { bundle, syntheticCapture } from './helpers.mjs';
const capturePreview = (...args) => syntheticCapture(rawCapturePreview, ...args);

for (const output of ['', '{}', '{"ok":false}', '{"ok":true,"skipped":true}', '{"ok":true,"warning":"unsupported"}',
  '{"ok":true,"warnings":["skipped"]}', '{"ok":true,"warnings":"skip"}', '{"ok":true}\n{"ok":true}', 'not json']) test(`control rejects ${JSON.stringify(output)}`, () => {
    assert.throws(() => parseReply(output));
});
test('stderr warnings are failures even with a successful JSON response', () => assert.throws(() => parseReply('{"ok":true}', 'skipped unsupported command')));
test('uses execFile argument arrays, an explicit endpoint and a bounded deadline', async () => {
  const calls = [];
  const control = createControl('/tmp/our-window.sock', async (...args) => {calls.push(args); return {stdout: '{"ok":true}', stderr: ''};});
  await control(`tree ${SURFACE}`);
  assert.deepEqual(calls[0].slice(0, 2), ['tern', ['ctl', '--control', '/tmp/our-window.sock', `tree ${SURFACE}`]]);
  assert.equal(calls[0][2].shell, undefined); assert.equal(calls[0][2].timeout, 25000);
  await assert.rejects(control('key 1\nrun anything'));
});
for (const endpoint of ['', 'localhost:123', 'https://example.test', '0', '65536', '/tmp/a\nkey 1']) test(`rejects endpoint ${JSON.stringify(endpoint)}`, () => assert.throws(() => createControl(endpoint)));
test('an aborted capture does not dispatch a control command', async () => {
  let calls = 0; const c = new AbortController(); c.abort();
  const control = createControl('/tmp/owned.sock', async () => {calls++;});
  await assert.rejects(control('state', c.signal)); assert.equal(calls, 0);
});
test('recipe captures four states and guards every input with the full preview identity', async () => {
  const commands = [], names = [];
  const b = bundle();
  const result = await capturePreview(b, {shotRoot: '/tmp/shots', control: async line => {commands.push(line); return {ok: true};},
    readCapture: async (_root, name) => {names.push(name); return {path: `/${name}.png`, sha256: 'd'.repeat(64), width: 100, height: 100, bytes: 100};}});
  assert.equal(result.status, 'captured-not-inspected'); assert.equal(result.shots.length, 4);
  assert.equal(new Set(names).size, 4);
  for (const [i, line] of commands.entries()) if (/^(key|click|size|appearance|shot) /.test(line)) {
    assert.equal(commands[i - 1], `tree ${SURFACE}`);
  }
  assert.ok(commands.includes(`tree ${SURFACE}`));
  assert.ok(!commands.includes(`tree "${SURFACE}"`));
  assert.ok(commands.some(line => line.includes('hermes.openui.child.src')));
});
test('missing PNG is not reported as successful capture', async () => {
  let inputs = 0;
  await assert.rejects(capturePreview(bundle(), {shotRoot: '/tmp/shots', control: async line => {if (line.startsWith('key')) inputs++; return {ok: true};},
    readCapture: async () => {throw new Error('PNG missing');}}), error => error.captureEvidence.status === 'capture-failed');
  assert.equal(inputs, 0);
});
test('failed identity check stops before any input', async () => {
  const lines = [];
  await assert.rejects(capturePreview(bundle(), {shotRoot: '/tmp/shots', control: async line => {lines.push(line); return {ok: false};}}));
  assert.equal(lines.length, 1); assert.match(lines[0], /^tree /);
});
test('flat input cannot pass the drill/back coverage requirement', async () => {
  const b = bundle({doc: {version: 1, title: 'flat', root: {id: 'root', label: 'root', code: 0, churn: 0, children: []}}});
  let calls = 0;
  await assert.rejects(capturePreview(b, {shotRoot: '/tmp/shots', control: async () => {calls++;}}), e => e.code === 'coverage');
  assert.equal(calls, 0);
});
test('shot inspection requires bytes and valid dimensions, not a claimed path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openui-shot-'));
  try {
    await assert.rejects(readShot(dir, 'absent'), e => e.code === 'capture-file');
    await writeFile(join(dir, 'bad.png'), Buffer.alloc(100));
    await assert.rejects(readShot(dir, 'bad'), e => e.code === 'capture-file');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('reads and hashes the actual bytes of a synthetic PNG fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openui-positive-shot-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAANElEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgx1lAABqFDyOQAAAABJRU5ErkJggg==', 'base64');
    await writeFile(join(dir, 'synthetic.png'), png);
    const result = await readShot(dir, 'synthetic');
    assert.equal(result.width, 100); assert.equal(result.height, 100);
    assert.equal(result.bytes, png.length); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {await rm(dir, {recursive: true, force: true});}
});
