import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGenerationAdapter } from '../../openui-generation/src/adapter.mjs';
import { fingerprints, prepareArtifact, createBundle } from '../src/bundle.mjs';
const adapter = await createGenerationAdapter();
const source = await readFile(new URL('../../openui-generation/fixtures/explorer.openui', import.meta.url), 'utf8');
const build = await fingerprints();
const artifact = prepareArtifact(await readFile(new URL('../fixtures/repository.json', import.meta.url), 'utf8'), build.rendererHash);

test('real OpenUI selection binds to real prepared document and checked-in renderer bytes', () => {
  const selection = adapter.compile(source, {scope: 'integration:branch', snapshots: new Map([['demo', artifact]])});
  const bundle = createBundle(selection, artifact, {width: 1280, height: 900, appearance: 'dark'}, build.bridgeHash);
  assert.equal(bundle.artifact.document.root.code, 1000);
  assert.equal(bundle.selection.snapshot.id, artifact.id);
  assert.equal(bundle.selection.status, 'validated-not-verified');
});
test('changed OpenUI composition reaches the view without changing data', () => {
  const selection = adapter.compile('root=RepoExplorer("demo","churn",[MetricRow(["files"]),HottestFiles(2)])',
    {scope: 'integration:branch', snapshots: new Map([['demo', artifact]])});
  const bundle = createBundle(selection, artifact, {width: 640, height: 480, appearance: 'light'}, build.bridgeHash);
  assert.deepEqual(bundle.selection.view.metrics, ['files']);
  assert.equal(bundle.selection.view.mode, 'churn'); assert.equal(bundle.selection.view.hottestLimit, 2);
});
