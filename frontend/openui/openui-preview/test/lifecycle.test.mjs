import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewSession } from '../src/lifecycle.mjs';
import { bundle, build, evidence, review, deferred } from './helpers.mjs';
const current = async () => build;
const driver = async b => evidence(b);
const session = () => new PreviewSession('session-a:branch-a');

test('a capture alone cannot authorize local publication', async () => {
  const s = session(); s.stage(bundle()); const result = await s.capture(driver, current);
  assert.equal(result.status, 'captured-not-inspected');
  await assert.rejects(s.publication(result, current), e => e.code === 'inspection');
});
test('human inspection unlocks an idempotent exact revision, not a regenerated artifact', async () => {
  const s = session(); const b = s.stage(bundle()); const capture = await s.capture(driver, current);
  const ticket = s.inspect(capture, review); const first = await s.publication(ticket, current);
  assert.equal(first.bundle, b); assert.equal(first.status, 'approved-for-local-publication');
  assert.equal(await s.publication(ticket, current), first);
  s.stage(bundle()); assert.equal(await s.publication(ticket, current), first);
});
test('copied receipts and tickets cannot substitute for host-owned objects', async () => {
  const s = session(); s.stage(bundle()); const capture = await s.capture(driver, current);
  assert.throws(() => s.inspect({...capture}, review));
  const ticket = s.inspect(capture, review);
  await assert.rejects(s.publication({...ticket}, current));
});
for (const invalid of [{}, {...review, accepted: false}, {...review, method: 'agent-says-ok'}, {...review, reviewer: ''}]) {
  test(`rejects incomplete or nonhuman inspection ${JSON.stringify(invalid)}`, async () => {
    const s = session(); s.stage(bundle()); assert.throws(() => s.inspect(evidence(bundle()), invalid));
    const capture = await s.capture(driver, current); assert.throws(() => s.inspect(capture, invalid));
  });
}
test('cancel aborts capture and rejects a late completion even if driver ignores signal', async () => {
  const s = session(), pending = deferred(), entered = deferred(); s.stage(bundle());
  let signal;
  const capture = s.capture(async (b, stop) => {signal = stop; entered.resolve(); await pending.promise; return evidence(b);}, current);
  await entered.promise; s.cancel(); assert.equal(signal.aborted, true); pending.resolve();
  await assert.rejects(capture, e => e.code === 'stale');
});
test('replacement cannot inherit previous capture or approval', async () => {
  const s = session(); s.stage(bundle()); const capture = await s.capture(driver, current); const ticket = s.inspect(capture, review);
  s.stage(bundle({mode: 'churn'})); assert.throws(() => s.inspect(capture, review));
  await assert.rejects(s.publication(ticket, current));
});
test('old capture cleanup cannot release a newer capture lease', async () => {
  const s = session(), old = deferred(), entered = deferred(), fresh = deferred(), enteredFresh = deferred(); s.stage(bundle());
  const first = s.capture(async b => {entered.resolve(); await old.promise; return evidence(b);}, current);
  await entered.promise; s.stage(bundle({mode: 'churn'}));
  const second = s.capture(async b => {enteredFresh.resolve(); await fresh.promise; return evidence(b);}, current);
  await enteredFresh.promise; old.resolve(); await assert.rejects(first);
  await assert.rejects(s.capture(driver, current), e => e.code === 'state');
  fresh.resolve(); assert.equal((await second).previewId, bundle({mode: 'churn'}).id);
});
test('source change during capture invalidates its result', async () => {
  const s = session(); s.stage(bundle()); let n = 0;
  await assert.rejects(s.capture(driver, async () => ++n === 1 ? build : {...build, rendererHash: 'e'.repeat(64)}), e => e.code === 'build');
});
test('scope switch invalidates an awaiting publication and clears the former session', async () => {
  const s = session(); s.stage(bundle()); const capture = await s.capture(driver, current); const ticket = s.inspect(capture, review);
  const gate = deferred(); const attempt = s.publication(ticket, () => gate.promise);
  s.switchScope('session-b:branch-a'); gate.resolve(build);
  await assert.rejects(attempt, e => e.code === 'stale');
  assert.equal(s.published, undefined); assert.throws(() => s.stage(bundle()));
});
test('failed replacement leaves the last good local publication available', async () => {
  const s = session(); s.stage(bundle()); const capture = await s.capture(driver, current);
  const prior = await s.publication(s.inspect(capture, review), current);
  s.stage(bundle({mode: 'churn'})); await assert.rejects(s.capture(async () => {throw new Error('renderer unavailable');}, current));
  assert.equal(s.published, prior);
});
test('cross-preview evidence is rejected', async () => {
  const s = session(); s.stage(bundle());
  await assert.rejects(s.capture(async () => evidence(bundle({mode: 'churn'})), current), e => e.code === 'evidence');
});
