import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePreview } from '../src/control.mjs';
import { bundle } from './helpers.mjs';

// Native control-tree shape, synthetic transport; NOT a live-window receipt.
function fixture(b, mutate = x => x) {
  let location = 'repo', mode = 'code';
  return async line => {
    if (line.startsWith('plugins expect')) return { ok: false, error: 'dock is not searched by plugins expect' };
    if (line === 'key 1') mode = 'code';
    if (line === 'key 2') mode = 'churn';
    if (line.startsWith('click ') || line === 'key Enter') location = 'src';
    if (line === 'key ArrowLeft') location = 'repo';
    if (line.startsWith('tree ')) return mutate({ ok: true, count: 2, nodes: [
      { class: 'sf-region sf-main', text: b.artifact.document.title, rect: [0, 0, 600, 500] },
      { class: 'sf-region sf-dock', text: `Preview: ${b.id}Location: ${location} | Mode: ${mode} | Selection: src`, rect: [0, 500, 600, 100] },
    ] });
    return { ok: true };
  };
}
const readCapture = async () => ({ path: '/synthetic.png', sha256: 'a'.repeat(64), bytes: 100, width: 100, height: 100 });

test('capture accepts exact identity and state from focused main+dock, without main-only expect', async () => {
  const b = bundle();
  const commands = [], base = fixture(b);
  const result = await capturePreview(b, { shotRoot: '/synthetic', readCapture, control: async line => {
    commands.push(line); return base(line);
  } });
  assert.equal(result.shots.length, 4);
  assert.equal(result.status, 'captured-not-inspected');
  assert(commands.filter(x => x.startsWith('tree ')).every(x => x.includes('.tn-pane.on')));
});

for (const [name, mutate] of [
  ['truncated ID', r => { r.nodes[1].text = r.nodes[1].text.replace(/Preview: [a-f0-9]{64}/, 'Preview: abc'); return r; }],
  ['wrong ID', r => { r.nodes[1].text = r.nodes[1].text.replace(/Preview: [a-f0-9]{64}/, `Preview: ${'f'.repeat(64)}`); return r; }],
  ['extended ID', r => { r.nodes[1].text = r.nodes[1].text.replace('Location:', 'fLocation:'); return r; }],
  ['wrong location', r => { r.nodes[1].text = r.nodes[1].text.replace('Location: repo ', 'Location: repo_other '); return r; }],
  ['missing dock', r => { r.nodes.pop(); return r; }],
  ['duplicate dock', r => { r.nodes.push(r.nodes[1]); return r; }],
  ['wrong main', r => { r.nodes[0].text = 'another plugin'; return r; }],
]) test(`capture fails closed for ${name}`, async () => {
  const b = bundle();
  let shots = 0;
  await assert.rejects(capturePreview(b, { shotRoot: '/synthetic', control: fixture(b, mutate),
    readCapture: async () => { shots++; return readCapture(); },
  }), e => e.captureEvidence?.status === 'capture-failed');
  assert.equal(shots, 0);
});
