import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocument, prepareArtifact, createBundle, validateBundle, assertCurrent } from '../src/bundle.mjs';
import { digest } from '../../openui-generation/src/catalog.mjs';
import { bundle, build, document } from './helpers.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
const resign = value => { const {id, ...body} = value; return {...body, id: digest(JSON.stringify(body))}; };

test('binds exact data, selection, presentation and source build without creating approval', () => {
  const a = bundle(); assert.equal(validateBundle(clone(a)).id, a.id);
  assert.equal(a.selection.status, 'validated-not-verified');
  assert.ok(Object.isFrozen(a.artifact.document.root.children));
  assert.equal('receipt' in a, false);
  assert.equal(a.artifact.document.root.code, 1000);
});
for (const change of [{mode: 'churn'}, {scope: 'session-b:branch-a'}, {metrics: ['files']}, {hottestLimit: 2}, {source: 'a new generation'},
  {presentation: {width: 640, height: 480, appearance: 'light'}}]) test(`identity changes: ${JSON.stringify(change)}`, () => {
  assert.notEqual(bundle(change).id, bundle().id);
});
for (const [name, alter] of [
  ['negative metric', d => {d.root.code = -1;}],
  ['wrong aggregate', d => {d.root.code++;}],
  ['duplicate id', d => {d.root.children[0].id = d.root.id;}],
  ['unknown handler', d => {d.root.command = 'unused';}],
  ['control label', d => {d.root.label = 'bad\u001b';}],
  ['invalid node id', d => {d.root.id = '../root';}],
  ['fractional data', d => {d.root.children[0].code = 1.5;}],
]) test(`rejects ${name}`, () => { const d = clone(document); alter(d); assert.throws(() => normalizeDocument(JSON.stringify(d))); });
test('caps bytes and depth before accepting a native document', () => {
  assert.throws(() => normalizeDocument(' '.repeat(8 * 1024 * 1024 + 1)), e => e.code === 'size');
  const d = clone(document); let root = d.root;
  for (let i = 0; i < 17; i++) root = {id: `n${i}`, label: 'nested', code: root.code, churn: root.churn, children: [root]};
  d.root = root; assert.throws(() => normalizeDocument(JSON.stringify(d)), e => e.code === 'bounds');
});
test('rejects changed data even if the outer bundle was rehashed', () => {
  const b = clone(bundle()); b.artifact.document.root.title = 'extra';
  assert.throws(() => validateBundle(resign(b)));
});
test('rejects fabricated selection props even if both outer hashes were recomputed', () => {
  const b = clone(bundle()); b.selection.view.metrics = ['madeUp']; b.selection = resign(b.selection);
  assert.throws(() => validateBundle(resign(b)), e => e.code === 'metrics');
});
test('catalog and generator mismatch fail closed', () => {
  for (const field of ['libraryHash', 'generator']) {
    const b = clone(bundle());
    if (field === 'libraryHash') b.selection.libraryHash = 'e'.repeat(64); else b.selection.generator.core = 'other';
    b.selection = resign(b.selection);
    assert.throws(() => validateBundle(resign(b)));
  }
});
test('rejects presentation values outside the measured view contract', () => {
  for (const width of [0, NaN, 2401, 500.5]) assert.throws(() => bundle({presentation: {width, height: 900, appearance: 'dark'}}));
});
test('rejects cross-session and changed renderer/adapter at the host boundary', () => {
  const b = bundle(); assertCurrent(b, b.selection.scope, build);
  assert.throws(() => assertCurrent(b, 'other', build), e => e.code === 'scope');
  for (const field of ['rendererHash', 'bridgeHash']) assert.throws(() => assertCurrent(b, b.selection.scope, {...build, [field]: 'e'.repeat(64)}), e => e.code === 'build');
});
test('mutation of a source document cannot modify an earlier bundle', () => {
  const d = clone(document), b = bundle({doc: d}); d.root.label = 'changed';
  assert.equal(b.artifact.document.root.label, 'demo');
  assert.equal(bundle().id, bundle().id);
});

test('snapshot output cannot target a symlink alias into watched plugin source', async () => {
  const { mkdtemp, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { assertOutputDirectory } = await import('../src/bundle.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'openui-output-'));
  try {
    await symlink(fileURLToPath(new URL('../tern/', import.meta.url)), join(dir, 'alias'));
    await assert.rejects(assertOutputDirectory(join(dir, 'alias', 'new', 'output')), e => e.code === 'output-source');
    assert.equal(await assertOutputDirectory(join(dir, 'outside')), join(dir, 'outside'));
  } finally {await rm(dir, {recursive: true, force: true});}
});
