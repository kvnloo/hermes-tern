import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { digest, freeze, requireInput } from '../../openui-generation/src/catalog.mjs';
import { validateBundle } from './bundle.mjs';

const runFile = promisify(execFile);
export const SURFACE = "[data-surface='plugin.hermes-openui.reply']";
export const FOCUSED_SURFACE = `.tn-pane.on ${SURFACE}`;
export const scriptQuote = value => JSON.stringify(value);

export function parseReply(stdout, stderr = '') {
  requireInput(typeof stdout === 'string' && Buffer.byteLength(stdout) <= 2_097_152, 'control', 'Oversized control reply.');
  const lines = stdout.trim().split(/\r?\n/);
  requireInput(lines.length === 1, 'control', 'Expected exactly one complete JSON reply.');
  const reply = JSON.parse(lines[0]);
  return requireCleanReply(reply, stderr);
}

// CLI and injected host transports must enforce the same success contract.
function requireCleanReply(reply, stderr = '') {
  requireInput(reply?.ok === true && !reply.error && !reply.skipped && !reply.skip &&
    !reply.warning && (reply.warnings === undefined || (Array.isArray(reply.warnings) && reply.warnings.length === 0)) && stderr.trim() === '',
    'control', 'Tern command failed, warned or skipped; it is not passing evidence.');
  return reply;
}

export function createControl(endpoint, execute = runFile) {
  requireInput(typeof endpoint === 'string' && endpoint.length <= 1024 && !/[\x00-\x1f\x7f]/.test(endpoint) &&
    (isAbsolute(endpoint) || (/^[0-9]+$/.test(endpoint) && +endpoint > 0 && +endpoint <= 65535)),
    'endpoint', 'Choose an explicit local control socket or TCP port.');
  return async (command, signal) => {
    signal?.throwIfAborted();
    requireInput(typeof command === 'string' && command.length < 2048 && !/[\r\n\0]/.test(command), 'command', 'Expected one bounded command.');
    const { stdout, stderr } = await execute('tern', ['ctl', '--control', endpoint, command], {
      encoding: 'utf8', timeout: 25_000, maxBuffer: 2_097_152, killSignal: 'SIGKILL', signal,
    });
    signal?.throwIfAborted();
    return parseReply(stdout, stderr);
  };
}

/** Inspect actual PNG files, not merely a successful request to take a screenshot. */
export async function readShot(root, name, signal) {
  requireInput(isAbsolute(root) && /^[a-zA-Z0-9_.-]+$/.test(name), 'capture-path', 'Invalid capture location.');
  const found = [];
  let entriesSeen = 0;
  async function walk(dir, depth) {
    signal?.throwIfAborted();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      requireInput(++entriesSeen <= 1024, 'capture-path', 'Use a dedicated, bounded capture directory.');
      if (entry.isDirectory() && depth < 3) await walk(join(dir, entry.name), depth + 1);
      if (entry.isFile() && entry.name === `${name}.png`) found.push(join(dir, entry.name));
    }
  }
  await walk(root, 0);
  requireInput(found.length === 1, 'capture-file', 'Expected exactly one fresh PNG from this shot.');
  const path = found[0], info = await stat(path);
  requireInput(info.size >= 64 && info.size <= 20 * 1024 * 1024, 'capture-file', 'Invalid screenshot size.');
  const bytes = await readFile(path);
  signal?.throwIfAborted();
  requireInput(bytes.length === info.size && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'capture-file', 'Missing PNG header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  requireInput(width >= 80 && height >= 80 && width <= 16_384 && height <= 16_384, 'capture-file', 'Invalid screenshot dimensions.');
  return freeze({ path, sha256: digest(bytes), bytes: bytes.length, width, height });
}

/** Real-window recipe; injected command/shot functions are for labelled transport tests only. */
export async function capturePreview(bundleInput, { control, shotRoot, readCapture = readShot }, signal) {
  const bundle = validateBundle(bundleInput);
  const budget = AbortSignal.timeout(120_000);
  const stop = signal ? AbortSignal.any([signal, budget]) : budget;
  const marker = `Preview: ${bundle.id}`;
  const checks = [], shots = [], replies = [];
  let replyBytes = 0;
  const command = async line => {
    stop.throwIfAborted();
    const raw = await control(line, stop);
    stop.throwIfAborted();
    const serialized = JSON.stringify(raw);
    requireInput(typeof serialized === 'string' && Buffer.byteLength(serialized) <= 2_097_152,
      'control', 'Oversized or invalid control reply.');
    replyBytes += Buffer.byteLength(serialized);
    requireInput(replyBytes <= 8_388_608, 'control', 'Capture replies exceeded the total 8 MiB budget.');
    // Snapshot replies before a transport reuses/mutates them. Retain bounded
    // failure diagnostics too, without counting them as successful commands.
    const reply = JSON.parse(serialized);
    replies.push({ command: line, reply });
    return requireCleanReply(reply);
  };
  // plugins expect searches main only. Inspect the focused pane's visible native
  // regions together, never a window-global match from another preview pane.
  const identity = async () => {
    const reply = await command(`tree ${FOCUSED_SURFACE}`);
    requireInput(Array.isArray(reply.nodes), 'identity', 'Missing focused native surface tree.');
    const region = name => reply.nodes.filter(node => typeof node.class === 'string' && node.class.split(/\s+/).includes(name));
    const main = region('sf-main'), dock = region('sf-dock');
    requireInput(main.length === 1 && dock.length === 1 &&
      typeof main[0].text === 'string' && main[0].text.startsWith(bundle.artifact.document.title.slice(0, 64)) &&
      typeof dock[0].text === 'string' && dock[0].text.match(/^Preview: ([a-f0-9]{64})(?=\s*Location:)/)?.[1] === bundle.id,
      'identity', `Focused main+dock must identify ${marker} exactly.`);
    return dock[0].text;
  };
  const expect = async text => {
    // Only observe/retry state reconciliation, never retry an input.
    const deadline = Date.now() + 25_000;
    while (true) {
      const dock = await identity();
      if (dock.includes(`${text} | Selection:`)) break;
      requireInput(Date.now() < deadline, 'state', 'Focused preview did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
      stop.throwIfAborted();
    }
    checks.push(text);
  };
  const act = async line => { await identity(); await command(line); };
  const prefix = `openui-${randomBytes(12).toString('hex')}`;
  async function shot(label) {
    await identity();
    await command(`shot ${prefix}-${label}`);
    const captured = await readCapture(shotRoot, `${prefix}-${label}`, stop);
    stop.throwIfAborted();
    // A pane can reload while the shot is written/read, including the last shot.
    // Pre/post identity checks reduce stale capture; they are not atomic attestation.
    await identity();
    shots.push({ label, ...captured });
  }
  try {
    const root = bundle.artifact.document.root;
    const limit = bundle.selection.view.visibleLimit;
    // The viewer reserves a cell for Other only when the child count exceeds
    // the limit. With exactly 128 children, the 128th is still directly visible.
    const visible = [...root.children].sort((a, b) => b.code - a.code || (a.id < b.id ? -1 : 1))
      .slice(0, root.children.length > limit ? limit - 1 : limit);
    const directory = visible.find(node => node.children.length > 0);
    requireInput(directory, 'coverage', 'This smoke recipe needs a visible directory with children; do not count a flat fixture as drill coverage.');
    await identity();
    // Control tree consumes the selector verbatim, unlike quoted scenario arguments.
    await command(`tree ${FOCUSED_SURFACE}`);
    await act(`size ${bundle.presentation.width} ${bundle.presentation.height}`);
    await act(`appearance ${bundle.presentation.appearance}`);
    await command('state'); await command('stats'); await command('css');
    await expect(`Location: ${root.id} | Mode: ${bundle.selection.view.mode}`);
    await shot('initial');
    await act('key 2'); await expect(`Location: ${root.id} | Mode: churn`); await shot('churn');
    await act('key 1'); await expect(`Location: ${root.id} | Mode: code`);
    // Stable scoped selectors, never pane-global click coordinates or generated commands.
    await act(`click ${scriptQuote(`.tn-pane.on .sf-main${SURFACE} [data-role='hermes.openui.child.${directory.id}']`)}`);
    await expect(`Location: ${directory.id} | Mode: code`); await shot('drill');
    await act('key ArrowLeft'); await expect(`Location: ${root.id} | Mode: code`);
    // Keyboard Enter must reopen the directory Back restored as the selection.
    await act('key Enter'); await expect(`Location: ${directory.id} | Mode: code`);
    await act('key ArrowLeft'); await expect(`Location: ${root.id} | Mode: code`);
    await act(bundle.selection.view.mode === 'churn' ? 'key 2' : 'key 1');
    await expect(`Location: ${root.id} | Mode: ${bundle.selection.view.mode}`); await shot('restored');
    await command(`tree ${FOCUSED_SURFACE}`);
    await command('state'); await command('stats');
    await identity();
    return freeze({ schema: 'tern-preview-capture/v1', previewId: bundle.id, status: 'captured-not-inspected',
      checks, shots, replies, limitations: ['Human pixel inspection required', 'No input-to-paint measurement', 'No production composer/focus or mobile coverage'] });
  } catch (error) {
    error.captureEvidence = { schema: 'tern-preview-capture/v1', previewId: bundle.id, status: 'capture-failed', checks, shots, replies };
    throw error;
  }
}
