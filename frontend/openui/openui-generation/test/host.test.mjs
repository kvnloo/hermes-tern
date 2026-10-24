import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SOURCE_BYTES } from '../src/catalog.mjs';
import { bindSelection, projectSelection } from '../src/host.mjs';
import { checkSource } from '../src/static-program.mjs';

const element = (typeName, props) => ({ type: 'element', typeName, props, partial: false, hasDynamicProps: false });
const tree = () => element('RepoExplorer', { snapshotId: 'demo', mode: 'code', sections: [
  element('MetricRow', { metrics: ['files', 'code', 'churn'] }), element('HottestFiles', { limit: 8 }),
] });
const context = () => ({ scope: 'session-a:branch-a', snapshots: new Map([
  ['demo', { id: 'a'.repeat(64), rendererHash: 'b'.repeat(64) }],
]) });
const bad = (fn, code) => assert.throws(fn, error => error.code === code);

test('projects only host-data selectors, not model metrics or commands', () => {
  const result = projectSelection(tree());
  assert.deepEqual(result, { snapshotId: 'demo', mode: 'code', metrics: ['files', 'code', 'churn'], hottestLimit: 8 });
  assert.ok(Object.isFrozen(result.metrics));
});
for (const field of ['partial', 'hasDynamicProps']) test(`rejects ${field} on a nested component`, () => {
  const root = tree(); root.props.sections[0][field] = true;
  bad(() => projectSelection(root), 'element');
});
test('rejects an unknown root prop rather than dropping its handler', () => {
  const root = tree(); root.props.onClick = 'anything';
  bad(() => projectSelection(root), 'props');
});
test('requires both sections; duplicated sections are not enough', () => {
  const root = tree(); root.props.sections[1] = root.props.sections[0];
  bad(() => projectSelection(root), 'element');
});
for (const metrics of [[], ['files', 'files'], ['invented'], [99]]) test(`rejects invalid metric selection ${JSON.stringify(metrics)}`, () => {
  const root = tree(); root.props.sections[0].props.metrics = metrics;
  bad(() => projectSelection(root), 'metrics');
});
for (const limit of [0, 13, 2.5, NaN, Infinity, '8']) test(`rejects invalid row limit ${String(limit)}`, () => {
  const root = tree(); root.props.sections[1].props.limit = limit;
  bad(() => projectSelection(root), 'limit');
});
for (const key of ['../private', 'file:///tmp/a', 'https://example.test', '']) test(`rejects path/URL snapshot key ${key}`, () => {
  const root = tree(); root.props.snapshotId = key;
  bad(() => projectSelection(root), 'snapshot');
});
test('rejects unsupported mode', () => {
  const root = tree(); root.props.mode = 'age';
  bad(() => projectSelection(root), 'mode');
});
test('copies and freezes the exact host handle; does not create visual approval', () => {
  const host = context();
  const selection = projectSelection(tree());
  const output = bindSelection(selection, 'source', host);
  assert.equal(output.status, 'validated-not-verified');
  assert.equal(output.snapshot.id, 'a'.repeat(64));
  host.snapshots.get('demo').id = 'c'.repeat(64);
  assert.equal(output.snapshot.id, 'a'.repeat(64));
  assert.ok(Object.isFrozen(output.snapshot));
  assert.ok(Object.isFrozen(output.view.metrics));
  assert.equal('receipt' in output, false);
});
test('unknown or malformed host handle fails closed', () => {
  const host = context(); host.snapshots.clear();
  bad(() => bindSelection(projectSelection(tree()), 'source', host), 'snapshot');
  host.snapshots.set('demo', { id: 'not-a-digest', rendererHash: 'b'.repeat(64) });
  bad(() => bindSelection(projectSelection(tree()), 'source', host), 'snapshot');
});
test('identity is stable only for identical source, scope, snapshot and renderer', () => {
  const selection = projectSelection(tree());
  const getId = host => bindSelection(selection, 'source', host).id;
  const first = getId(context());
  assert.equal(first, getId(context()));
  assert.notEqual(first, bindSelection(selection, 'source\n', context()).id);
  const scope = context(); scope.scope = 'session-b:branch-a'; assert.notEqual(first, getId(scope));
  for (const field of ['id', 'rendererHash']) {
    const host = context(); host.snapshots.get('demo')[field] = 'c'.repeat(64);
    assert.notEqual(first, getId(host));
  }
});
test('source gate permits JSON-escaped strings without treating their text as code', () => {
  checkSource('root = RepoExplorer("Query(\\\"x\\\")", "code", [metrics, hottest])');
});
for (const source of ['', '   ', 'root = X("unfinished)', 'root = X([1))',
  'root = X("bad\\q")', 'root = X(1);', '$state = 1', 'root = X(@Count(x))',
  'root = X({})', 'root = X(1 + 2)', '```openui\nroot = X()\n```', 'root = X() # comment']) {
  test(`source gate rejects ${JSON.stringify(source)}`, () => assert.throws(() => checkSource(source)));
}
test('source limit applies to bytes, including whitespace', () => {
  bad(() => checkSource(' '.repeat(MAX_SOURCE_BYTES) + 'x'), 'size');
});
test('depth is capped before invoking the upstream recursive parser', () => {
  bad(() => checkSource('root=' + '['.repeat(17) + '1' + ']'.repeat(17)), 'depth');
});
test('strings are bounded before upstream parsing', () => {
  bad(() => checkSource('root="' + 'x'.repeat(257) + '"'), 'string');
});
