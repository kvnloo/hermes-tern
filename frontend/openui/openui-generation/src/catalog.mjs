import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const MAX_SOURCE_BYTES = 32_768;
export const METRICS = Object.freeze(['files', 'code', 'churn']);
export const LIMITS = Object.freeze({ depth: 16, statements: 32, nodes: 256, hottest: 12, visible: 128 });

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export class VisualInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualInputError';
    this.code = code;
  }
}
export function requireInput(condition, code, message) {
  if (!condition) throw new VisualInputError(code, message);
}

// Property insertion order is the upstream parser's positional argument order.
// Names describe our reviewed views, not first-party OpenUI components.
export const CATALOG = freeze({
  RepoExplorer: {
    signature: 'RepoExplorer(snapshotId: string, mode: "code" | "churn", sections: Component[])',
    description: 'Select one host-approved repository snapshot. Include exactly one MetricRow and one HottestFiles. Never invent repository data.',
    properties: {
      snapshotId: { type: 'string' },
      mode: { type: 'string', enum: ['code', 'churn'] },
      sections: { type: 'array', items: {} },
    },
  },
  MetricRow: {
    signature: 'MetricRow(metrics: string[])',
    description: 'Select one to three distinct host-computed metrics: files, code, churn. Do not provide numeric values or labels.',
    properties: { metrics: { type: 'array', items: { type: 'string', enum: METRICS } } },
  },
  HottestFiles: {
    signature: 'HottestFiles(limit: number)',
    description: 'Request the existing hottest-file view with an integer row limit from 1 to 12.',
    properties: { limit: { type: 'number', minimum: 1, maximum: LIMITS.hottest } },
  },
});
export const SCHEMA = freeze({
  properties: Object.fromEntries(Object.keys(CATALOG).map(name => [name, {}])),
  $defs: Object.fromEntries(Object.entries(CATALOG).map(([name, spec]) => [name, {
    type: 'object', additionalProperties: false,
    properties: spec.properties, required: Object.keys(spec.properties),
  }])),
});
export const LIBRARY = freeze({
  id: 'hermes-native-repository/v1', root: 'RepoExplorer', schema: SCHEMA,
  components: Object.fromEntries(Object.entries(CATALOG).map(([name, { signature, description }]) => [name, { signature, description }])),
});
export const LIBRARY_HASH = digest(JSON.stringify({ LIBRARY, LIMITS, MAX_SOURCE_BYTES }));

/** No dependency import or telemetry initialization until explicitly requested. */
export function assertTelemetryDisabled() {
  requireInput(process.env.OPENUI_TELEMETRY_DISABLED === '1' || process.env.DO_NOT_TRACK === '1',
    'telemetry', 'Disable OpenUI telemetry before loading: OPENUI_TELEMETRY_DISABLED=1.');
}

export async function loadCore() {
  assertTelemetryDisabled();
  const core = await import('@openuidev/lang-core');
  for (const name of ['createParser', 'generateSystemPrompt', 'tokenize', 'split', 'parseExpression']) {
    requireInput(typeof core[name] === 'function', 'dependency-contract', `Installed lang-core does not export ${name}.`);
  }
  return core;
}
