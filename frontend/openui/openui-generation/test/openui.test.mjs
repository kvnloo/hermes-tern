import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGenerationAdapter } from '../src/adapter.mjs';

// These tests require the actual pinned npm package; they never replace its parser.
const adapter = await createGenerationAdapter();
const source = await readFile(new URL('../fixtures/explorer.openui', import.meta.url), 'utf8');
const host = JSON.parse(await readFile(new URL('../fixtures/host.json', import.meta.url), 'utf8'));
const context = () => ({ scope: host.scope, snapshots: new Map(Object.entries(host.snapshots)) });
const compile = program => adapter.compile(program, context());

test('real upstream parser resolves forward references into a validated handoff', () => {
  const result = compile(source);
  assert.equal(result.status, 'validated-not-verified');
  assert.deepEqual(result.view, { kind: 'repo-explorer', mode: 'code', metrics: ['files', 'code', 'churn'], hottestLimit: 8, visibleLimit: 128 });
  assert.equal(result.snapshot.id, host.snapshots.demo.id);
});
test('same catalog supports inline composition and reversed section order', () => {
  const result = compile('root=RepoExplorer("demo","churn",[HottestFiles(1),MetricRow(["churn"])])');
  assert.equal(result.view.mode, 'churn');
  assert.equal(result.view.hottestLimit, 1);
});
test('root can follow its referenced declarations', () => {
  const lines = source.trim().split('\n');
  const result = compile([lines[1], lines[2], lines[0]].join('\n'));
  assert.equal(result.view.mode, 'code');
});
test('library prompt is stable across data changes and lists the actual catalog', () => {
  const before = adapter.prompt;
  compile(source);
  compile(source.replace('"code", [metrics', '"churn", [metrics'));
  assert.equal(adapter.prompt, before);
  assert.match(before, /RepoExplorer/);
  assert.match(before, /MetricRow/);
  assert.match(before, /HottestFiles/);
});
const invalid = {
  'hidden Query': source + '\nhidden = Query("remote", [], [])',
  'hidden Mutation': source + '\nhidden = Mutation("write", [])',
  'hidden Action': source + '\nhidden = Action([])',
  'unused valid component': source + '\nhidden = HottestFiles(2)',
  'missing reference': source.replace('[metrics, hottest]', '[metrics, missing]'),
  'cyclic reference': source.replace('hottest = HottestFiles(8)', 'hottest = again\nagain = hottest'),
  'duplicate root': source + '\nroot = RepoExplorer("demo", "churn", [metrics, hottest])',
  'extra argument': source.replace('HottestFiles(8)', 'HottestFiles(8, 9)'),
  'missing comma': source.replace('"demo", "code"', '"demo" "code"'),
  'trailing expression': source.replace('HottestFiles(8)', 'HottestFiles(8) HottestFiles(9)'),
  'skipped statement': source + '\nthis line has no assignment',
  'unfinished component': source.slice(0, source.lastIndexOf(')')),
  'unfinished string': 'root=RepoExplorer("dem',
  'state': source + '\n$state=1',
  'builtin': source.replace('8)', '@Count([8]))'),
  'operator': source.replace('8)', '4+4)'),
  'unsupported mode': source.replace('"code", [metrics', '"age", [metrics'),
  'invented metric': source.replace('"files", "code", "churn"', '"files", "fake"'),
  'invalid row limit': source.replace('HottestFiles(8)', 'HottestFiles(13)'),
  'unknown host snapshot': source.replace('"demo"', '"other"'),
  'wrong root': 'root=MetricRow(["files"])',
  'recovered missing section': 'root=RepoExplorer("demo","code",[MetricRow(["files"]),Unknown(1)])',
};
for (const [name, program] of Object.entries(invalid)) test(`real parser cannot admit ${name}`, () => {
  assert.throws(() => compile(program));
});
test('repeated reference expansion is bounded before materialization', () => {
  const lines = ['x0=MetricRow(["files"])'];
  for (let index = 1; index < 10; index++) lines.push(`x${index}=[x${index - 1},x${index - 1}]`);
  lines.push('root=RepoExplorer("demo","code",[x9,HottestFiles(8)])');
  assert.throws(() => compile(lines.join('\n')), error => error.code === 'expansion');
});
test('malformed output does not alter any previously compiled handoff', () => {
  const good = compile(source);
  const prior = JSON.stringify(good);
  assert.throws(() => compile(source + '\nhidden = Query("remote", [], [])'));
  assert.equal(JSON.stringify(good), prior);
  assert.equal(compile(source).id, good.id);
});
test('removing telemetry opt-out rejects further parser calls', () => {
  const old = [process.env.OPENUI_TELEMETRY_DISABLED, process.env.DO_NOT_TRACK];
  delete process.env.OPENUI_TELEMETRY_DISABLED; delete process.env.DO_NOT_TRACK;
  try { assert.throws(() => compile(source), error => error.code === 'telemetry'); }
  finally {
    for (const [index, key] of ['OPENUI_TELEMETRY_DISABLED', 'DO_NOT_TRACK'].entries()) {
      if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index];
    }
  }
});
