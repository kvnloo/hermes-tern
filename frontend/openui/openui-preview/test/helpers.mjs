import { readFile } from 'node:fs/promises';
import { prepareArtifact, createBundle } from '../src/bundle.mjs';
import { bindSelection } from '../../openui-generation/src/host.mjs';
export const document = JSON.parse(await readFile(new URL('../fixtures/repository.json', import.meta.url), 'utf8'));
export const build = { rendererHash: 'b'.repeat(64), bridgeHash: 'c'.repeat(64) };
export function bundle(overrides = {}) {
  const { scope = 'session-a:branch-a', mode = 'code', metrics = ['files', 'code', 'churn'], hottestLimit = 8, doc = document, source = 'synthetic validated selection', presentation = {width: 1280, height: 900, appearance: 'dark'} } = overrides;
  const artifact = prepareArtifact(JSON.stringify(doc), build.rendererHash);
  const selection = bindSelection({ snapshotId: 'demo', mode, metrics, hottestLimit }, source, {scope, snapshots: new Map([['demo', artifact]])});
  return createBundle(selection, artifact, presentation, build.bridgeHash);
}
export const evidence = b => ({schema: 'tern-preview-capture/v1', previewId: b.id, status: 'captured-not-inspected',
  checks: ['synthetic transport check'], shots: [{sha256: 'd'.repeat(64), path: '/synthetic.png'}]});
export const review = {method: 'human-inspected', accepted: true, reviewer: 'Test reviewer'};
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }

// Labelled synthetic native-tree transport for recipe contract tests.
export function syntheticCapture(capture, b, options, signal) {
  let location = b.artifact.document.root.id, mode = b.selection.view.mode;
  const root = location;
  const children = [...b.artifact.document.root.children].sort((a, z) => z.code - a.code || (a.id < z.id ? -1 : 1));
  const directory = children.find(n => n.children.length > 0)?.id;
  return capture(b, { ...options, control: async (line, stop) => {
    const reply = await options.control(line, stop);
    if (line === 'key 1') mode = 'code';
    if (line === 'key 2') mode = 'churn';
    if (line.startsWith('click ') || line === 'key Enter') location = directory;
    if (line === 'key ArrowLeft') location = root;
    if (line.startsWith('tree ') && reply?.ok === true && !reply.nodes && !reply.error && !reply.skip && !reply.skipped && !reply.warning &&
      (reply.warnings === undefined || (Array.isArray(reply.warnings) && reply.warnings.length === 0))) return { ...reply, nodes: [
      { class: 'sf-main', text: b.artifact.document.title },
      { class: 'sf-dock', text: `Preview: ${b.id}Location: ${location} | Mode: ${mode} | Selection: none` },
    ] };
    return reply;
  } }, signal);
}
