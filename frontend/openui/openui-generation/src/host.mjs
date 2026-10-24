import { CATALOG, LIBRARY_HASH, LIMITS, METRICS, digest, freeze, requireInput } from './catalog.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function component(node, name) {
  requireInput(node?.type === 'element' && node.typeName === name && node.partial === false && node.hasDynamicProps !== true,
    'element', `Expected a complete static ${name}.`);
  const props = node.props;
  requireInput(props && typeof props === 'object' && !Array.isArray(props), 'props', 'Expected named component properties.');
  const expected = Object.keys(CATALOG[name].properties).sort();
  requireInput(JSON.stringify(Object.keys(props).sort()) === JSON.stringify(expected), 'props', `Unexpected ${name} properties.`);
  return props;
}

/** Converts only selection/composition. Numeric repository data never comes from the model. */
export function projectSelection(root) {
  const props = component(root, 'RepoExplorer');
  requireInput(id(props.snapshotId), 'snapshot', 'Use a host-provided snapshot key, not a path or URL.');
  requireInput(['code', 'churn'].includes(props.mode), 'mode', 'Unknown repository mode.');
  requireInput(Array.isArray(props.sections) && props.sections.length === 2, 'sections', 'Include exactly a MetricRow and HottestFiles.');
  const sections = new Map(props.sections.map(node => [node?.typeName, node]));
  const metrics = component(sections.get('MetricRow'), 'MetricRow').metrics;
  requireInput(Array.isArray(metrics) && metrics.length > 0 && metrics.length <= METRICS.length &&
    metrics.every(metric => METRICS.includes(metric)) && new Set(metrics).size === metrics.length,
    'metrics', 'Metrics must be a nonempty distinct subset of files, code, churn.');
  const limit = component(sections.get('HottestFiles'), 'HottestFiles').limit;
  requireInput(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.hottest, 'limit', 'Hottest-file limit must be an integer from 1 to 12.');
  return freeze({ snapshotId: props.snapshotId, mode: props.mode, metrics: [...metrics], hottestLimit: limit });
}

/** Bind to a host-scoped existing PreparedArtifact handle, without copying its document. */
export function bindSelection(selection, source, context) {
  requireInput(typeof context?.scope === 'string' && context.scope.length > 0 && context.scope.length <= 256,
    'scope', 'A host-owned session/branch scope is required.');
  requireInput(context.snapshots instanceof Map, 'snapshot', 'Expected a host-owned snapshot registry.');
  const snapshot = context.snapshots.get(selection.snapshotId);
  requireInput(snapshot && hash(snapshot.id) && hash(snapshot.rendererHash), 'snapshot', 'Unknown or invalid prepared-artifact handle.');
  const handoff = {
    schema: 'native-visual-selection/v1', status: 'validated-not-verified',
    generator: { core: '@openuidev/lang-core@0.3.1', adapter: 'bounded-repository-selection/v1' },
    scope: context.scope, sourceHash: digest(source), libraryHash: LIBRARY_HASH,
    snapshot: { key: selection.snapshotId, id: snapshot.id, rendererHash: snapshot.rendererHash },
    view: { kind: 'repo-explorer', mode: selection.mode, metrics: [...selection.metrics],
      hottestLimit: selection.hottestLimit, visibleLimit: LIMITS.visible },
  };
  return freeze({ ...handoff, id: digest(JSON.stringify(handoff)) });
}
