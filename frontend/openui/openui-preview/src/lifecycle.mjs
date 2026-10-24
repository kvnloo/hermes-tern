import { randomUUID } from 'node:crypto';
import { freeze, requireInput } from '../../openui-generation/src/catalog.mjs';
import { validateBundle, assertCurrent } from './bundle.mjs';

/** Host-only coordinator. Does not mount production UI, import receipts or grant tool approval. */
export class PreviewSession {
  #scope; #current; #epoch = 0; #controller; #capture; #ticket; #published;
  constructor(scope) { this.#scope = scope; }
  get published() { return this.#published; }
  stage(bundle) {
    const next = validateBundle(bundle);
    requireInput(next.selection.scope === this.#scope, 'scope', 'Wrong session/branch.');
    // A genuinely identical retry retains its inspection. A replacement does not.
    if (next.id === this.#current?.id) return this.#current;
    this.cancel(); this.#current = next;
    return next;
  }
  cancel() {
    this.#epoch++;
    this.#controller?.abort();
    this.#controller = this.#capture = this.#ticket = undefined;
    this.#current = undefined;
  }
  switchScope(scope) { this.cancel(); this.#scope = scope; this.#published = undefined; }
  async capture(driver, getCurrentBuild) {
    requireInput(this.#current && !this.#controller, 'state', 'Stage a preview; only one capture may run.');
    const bundle = this.#current, epoch = this.#epoch, controller = new AbortController();
    this.#controller = controller; this.#capture = this.#ticket = undefined;
    const current = () => requireInput(this.#epoch === epoch && this.#current === bundle && !controller.signal.aborted,
      'stale', 'Capture belongs to an obsolete preview.');
    try {
      const before = await getCurrentBuild(); current(); assertCurrent(bundle, this.#scope, before);
      const evidence = await driver(bundle, controller.signal); current();
      const after = await getCurrentBuild(); current(); assertCurrent(bundle, this.#scope, after);
      requireInput(evidence?.schema === 'tern-preview-capture/v1' && evidence.previewId === bundle.id &&
        evidence.status === 'captured-not-inspected' && evidence.checks?.length > 0 && evidence.shots?.length > 0,
        'evidence', 'A matching capture, not a boolean success flag, is required.');
      // The driver's own schema/PNG checks precede this host-only boundary.
      const result = freeze(JSON.parse(JSON.stringify(evidence)));
      this.#capture = result;
      return result;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
  inspect(capture, review) {
    requireInput(this.#current && capture === this.#capture, 'evidence', 'Inspect this session’s actual capture object.');
    requireInput(review?.method === 'human-inspected' && review.accepted === true &&
      typeof review.reviewer === 'string' && review.reviewer.trim().length > 0 && review.reviewer.length <= 160,
      'inspection', 'Explicit human inspection is required; capture is not visual approval.');
    this.#ticket = freeze({ token: randomUUID(), previewId: this.#current.id, method: 'human-inspected', reviewer: review.reviewer.trim() });
    return this.#ticket;
  }
  async publication(ticket, getCurrentBuild) {
    requireInput(ticket && ticket === this.#ticket && this.#current, 'inspection', 'No current inspection ticket.');
    const bundle = this.#current, epoch = this.#epoch;
    const build = await getCurrentBuild();
    requireInput(epoch === this.#epoch && this.#current === bundle && ticket === this.#ticket, 'stale', 'Preview changed during publication check.');
    assertCurrent(bundle, this.#scope, build);
    if (this.#published?.previewId === bundle.id) return this.#published;
    // Return the exact approved data to the host. No external sharing or session mutation here.
    this.#published = freeze({ status: 'approved-for-local-publication', previewId: bundle.id, bundle, inspection: ticket });
    return this.#published;
  }
}
