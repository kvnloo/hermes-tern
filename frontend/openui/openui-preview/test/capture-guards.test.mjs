import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePreview as rawCapturePreview } from '../src/control.mjs';
import { bundle, syntheticCapture } from './helpers.mjs';
const capturePreview = (...args) => syntheticCapture(rawCapturePreview, ...args);

// These are transport/recipe tests, not Tern or rendered-pixel evidence.
const shot = name => ({ path: `/synthetic/${name}.png`, sha256: 'd'.repeat(64), width: 100, height: 100, bytes: 100 });
const transport = overrides => ({
  shotRoot: '/synthetic', control: async () => ({ ok: true }),
  readCapture: async (_root, name) => shot(name), ...overrides,
});
const failed = error => error.captureEvidence?.status === 'capture-failed';

function lastDirectory(count, zero = false) {
  const children = Array.from({ length: count - 1 }, (_, i) => ({
    id: `f${String(i).padStart(3, '0')}`, label: `file-${i}`,
    code: zero ? 0 : count - i, churn: 0, children: [],
  }));
  const leaf = { id: 'leaf', label: 'leaf', code: zero ? 0 : 1, churn: 0, children: [] };
  children.push({ id: 'zz_directory', label: 'directory/', code: leaf.code, churn: 0, children: [leaf] });
  return { version: 1, title: 'Synthetic visibility boundary', root: {
    id: 'root', label: 'root', code: children.reduce((sum, n) => sum + n.code, 0), churn: 0, children,
  } };
}

for (const count of [127, 128]) test(`drills a directory in visible slot ${count}`, async () => {
  const commands = [];
  const result = await capturePreview(bundle({ doc: lastDirectory(count) }), transport({
    control: async line => { commands.push(line); return { ok: true }; },
  }));
  assert.equal(result.status, 'captured-not-inspected');
  assert.equal(result.shots.length, 4);
  assert.ok(commands.some(line => line.startsWith('click ') && line.includes('child.zz_directory')));
});

test('all-zero ties keep the actual 128th cell available for drill coverage', async () => {
  const result = await capturePreview(bundle({ mode: 'churn', doc: lastDirectory(128, true) }), transport());
  assert.equal(result.status, 'captured-not-inspected');
});

test('the 128th original child is hidden behind Other when there are 129 children', async () => {
  const doc = lastDirectory(128);
  doc.root.children.push({ id: 'zzz_extra', label: 'extra', code: 0, churn: 0, children: [] });
  let calls = 0;
  await assert.rejects(capturePreview(bundle({ doc }), transport({
    control: async () => { calls++; return { ok: true }; },
  })), error => failed(error) && error.code === 'coverage');
  assert.equal(calls, 0);
});

for (const reply of [
  { ok: true, error: 'partial failure' }, { ok: true, skip: true },
  { ok: true, warnings: ['unsupported'] }, { ok: true, warnings: 'unsupported' },
  { ok: false, error: 'wrong pane' }, { ok: true, skipped: true },
  { ok: true, warning: 'not supported' },
]) test(`recipe rejects and retains diagnostic reply ${JSON.stringify(reply)}`, async () => {
  let calls = 0;
  await assert.rejects(capturePreview(bundle(), transport({
    control: async () => { calls++; return reply; },
  })), error => {
    assert.equal(error.captureEvidence?.status, 'capture-failed');
    assert.deepEqual(error.captureEvidence.replies.at(-1)?.reply, reply);
    return error.code === 'control';
  });
  assert.equal(calls, 1);
});

test('valid empty warning lists are allowed and stored replies do not alias the transport', async () => {
  const shared = { ok: true, warnings: [], state: { value: 'initial' } };
  const result = await capturePreview(bundle(), transport({ control: async () => shared }));
  assert.equal(result.status, 'captured-not-inspected');
  assert.notEqual(result.replies[0].reply, shared);
  shared.state.value = 'changed';
  assert.equal(result.replies[0].reply.state.value, 'initial');
});

test('injected transports obey the same per-reply size bound as the CLI', async () => {
  let calls = 0;
  await assert.rejects(capturePreview(bundle(), transport({ control: async () => {
    calls++; return calls === 1 ? { ok: true, data: 'x'.repeat(2_097_153) } : { ok: true };
  } })), error => failed(error) && error.code === 'control');
  assert.equal(calls, 1);
});

test('cancellation while the final metadata reply is in flight cannot report a capture pass', async () => {
  const controller = new AbortController(); let stats = 0;
  await assert.rejects(capturePreview(bundle(), transport({ control: async line => {
    if (line === 'stats' && ++stats === 2) controller.abort();
    return { ok: true };
  } }), controller.signal), error => failed(error) && error.name === 'AbortError');
});

test('a PNG completed after cancellation is not counted as captured evidence', async () => {
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(capturePreview(bundle(), transport({ readCapture: async (_root, name) => {
    if (++reads === 4) controller.abort();
    return shot(name);
  } }), controller.signal), error => {
    assert.equal(error.captureEvidence?.status, 'capture-failed');
    assert.equal(error.captureEvidence.shots.length, 3);
    return error.name === 'AbortError';
  });
});

test('a preview replacement during the last PNG read invalidates that shot', async () => {
  let changed = false, reads = 0;
  await assert.rejects(capturePreview(bundle(), transport({
    readCapture: async (_root, name) => { if (++reads === 4) changed = true; return shot(name); },
    control: async line => line.startsWith('tree ') && changed
      ? { ok: false, error: 'preview identity changed' } : { ok: true },
  })), error => failed(error) && error.captureEvidence.shots.length === 3);
});

test('replacement during final metadata collection also invalidates capture success', async () => {
  let changed = false, stats = 0;
  await assert.rejects(capturePreview(bundle(), transport({ control: async line => {
    if (line === 'stats' && ++stats === 2) changed = true;
    if (changed && line.startsWith('tree ')) return { ok: false, error: 'changed' };
    return { ok: true };
  } })), failed);
});
