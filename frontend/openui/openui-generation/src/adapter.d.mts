export interface PreparedArtifactHandle {
  /** Immutable host-prepared artifact content identity; not a file path. */
  readonly id: string;
  readonly rendererHash: string;
}
export interface GenerationContext {
  /** Host-owned session/branch identity, never chosen by generated code. */
  readonly scope: string;
  readonly snapshots: ReadonlyMap<string, PreparedArtifactHandle>;
}
export interface VisualSelection {
  readonly schema: 'native-visual-selection/v1';
  readonly status: 'validated-not-verified';
  readonly scope: string;
  readonly id: string;
  readonly sourceHash: string;
  readonly libraryHash: string;
  readonly generator: {
    readonly core: '@openuidev/lang-core@0.3.1';
    readonly adapter: 'bounded-repository-selection/v1';
  };
  readonly snapshot: { readonly key: string; readonly id: string; readonly rendererHash: string };
  readonly view: {
    readonly kind: 'repo-explorer';
    readonly mode: 'code' | 'churn';
    readonly metrics: readonly ('files' | 'code' | 'churn')[];
    readonly hottestLimit: number;
    readonly visibleLimit: 128;
  };
}
export interface GenerationAdapter {
  readonly prompt: string;
  /** Call only once the host knows the model's program is complete. Not visual approval. */
  compile(source: string, context: GenerationContext): VisualSelection;
}
export function createGenerationAdapter(): Promise<GenerationAdapter>;
