export type SystemName = 'Raticross' | 'Signal' | 'CosyWorld' | 'Swarm';
export type Origin = 'human' | 'agent' | 'timer' | 'system' | 'replay';
export type Integrity = 'verified' | 'recorded' | 'review';
export type SourceState = 'live' | 'empty' | 'unconfigured' | 'error';

export type Receipt = {
  id: string;
  system: SystemName;
  mark: string;
  color: 'coral' | 'blue' | 'gold' | 'violet';
  title: string;
  actor: string;
  actorNote: string;
  origin: Origin;
  time: string;
  date: string;
  observedAt: string | null;
  integrity: Integrity;
  algorithm: string;
  summary: string;
  parent: string;
  parentLabel: string;
  hash: string;
  duration: string;
  replay: string;
  proof: string;
  path: Array<{ label: string; note: string; ms: string }>;
  changes: Array<{ field: string; before: string; after: string }>;
  payload: Record<string, unknown>;
};

export type SourceStatus = {
  system: SystemName;
  state: SourceState;
  detail: string;
  receiptCount: number;
};

export type ReceiptFeed = {
  mode: 'live';
  generatedAt: string;
  receipts: Receipt[];
  sources: SourceStatus[];
};

export const SYSTEMS: readonly SystemName[] = [
  'Raticross',
  'Signal',
  'CosyWorld',
  'Swarm',
];
