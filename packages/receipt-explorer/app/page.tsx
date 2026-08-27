'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Origin = 'human' | 'agent' | 'timer' | 'system' | 'replay';
type Integrity = 'verified' | 'review';

type Receipt = {
  id: string;
  system: 'Raticross' | 'Signal' | 'CosyWorld' | 'Swarm';
  mark: string;
  color: string;
  title: string;
  actor: string;
  actorNote: string;
  origin: Origin;
  time: string;
  date: string;
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

const receipts: Receipt[] = [
  {
    id: 'rati_7f3c92a1', system: 'Raticross', mark: 'R', color: 'coral', title: 'Envelope accepted',
    actor: 'agent:cenetex', actorNote: 'key · 3bc2…91a7', origin: 'agent', time: '12:42:18.084', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Ed25519', summary: 'A signed agent request crossed the Raticross boundary and passed every integrity check.',
    parent: 'swm_8b19…5e02', parentLabel: 'Tool claim', hash: 'sha256:af42d8…c930', duration: '84 ms', replay: 'Deterministic input captured',
    proof: 'The payload is unchanged since it was signed by the declared actor. This receipt does not prove that the action was wise or correct.',
    path: [
      { label: 'Request signed', note: 'Payload hash created by agent:cenetex', ms: '0 ms' },
      { label: 'Envelope received', note: 'Header parsed and schema matched', ms: '17 ms' },
      { label: 'Signature verified', note: 'Public key matched the declared actor', ms: '31 ms' },
      { label: 'Action accepted', note: 'Receipt committed to the local journal', ms: '84 ms' },
    ],
    changes: [
      { field: 'claim.status', before: 'pending', after: 'accepted' },
      { field: 'claim.sequence', before: '18420', after: '18421' },
    ],
    payload: { type: 'claim.accept', claimId: 'clm_8b195e02', sequence: 18421, capability: 'receipt.write', result: 'accepted' },
  },
  {
    id: 'sig_84bf0d6e', system: 'Signal', mark: 'S', color: 'blue', title: 'Move committed',
    actor: 'player:fern-07', actorNote: 'session · 77f2…0ca4', origin: 'human', time: '12:41:56.913', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Relay sequence', summary: 'The authoritative relay accepted a player move and emitted a relevance-filtered snapshot.',
    parent: 'sig_84bf…0d31', parentLabel: 'Input intent', hash: 'sha256:983c4a…71bb', duration: '43 ms', replay: 'Input frame 91,204 captured',
    proof: 'The relay committed this input once at the recorded sequence. Client prediction is not treated as authoritative evidence.',
    path: [
      { label: 'Intent received', note: 'Client frame and session validated', ms: '0 ms' },
      { label: 'Action deduplicated', note: 'Idempotency key was new', ms: '8 ms' },
      { label: 'World step applied', note: 'Authoritative state advanced', ms: '24 ms' },
      { label: 'Snapshot emitted', note: 'Nearby state filtered for the player', ms: '43 ms' },
    ],
    changes: [
      { field: 'player.x', before: '112.40', after: '113.05' },
      { field: 'player.energy', before: '76', after: '75' },
    ],
    payload: { type: 'player.move', frame: 91204, direction: [0.65, 0], idempotencyKey: 'move_91204_fern07' },
  },
  {
    id: 'cosy_b0ee4c21', system: 'CosyWorld', mark: 'C', color: 'gold', title: 'Harvest resolved',
    actor: 'timer:world-tick', actorNote: 'kernel tick · 8421', origin: 'timer', time: '12:41:44.002', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Journal checksum', summary: 'A deterministic world tick resolved a ready crop and wrote the result to the action journal.',
    parent: 'cosy_b0ee…48dd', parentLabel: 'World tick', hash: 'sha256:63de10…a024', duration: '12 ms', replay: 'Kernel seed and command captured',
    proof: 'The same kernel version, seed, and input command reproduce this state transition byte for byte.',
    path: [
      { label: 'Tick opened', note: 'Kernel loaded the prior world state', ms: '0 ms' },
      { label: 'Command selected', note: 'Ready crop matched harvest rule', ms: '3 ms' },
      { label: 'Kernel advanced', note: 'Deterministic transition completed', ms: '8 ms' },
      { label: 'Journal committed', note: 'Receipt and outbox entry persisted', ms: '12 ms' },
    ],
    changes: [
      { field: 'plot.12.crop', before: 'turnip:ready', after: 'empty' },
      { field: 'inventory.turnip', before: '8', after: '9' },
    ],
    payload: { command: 'harvest', plotId: 12, tick: 8421, kernel: 'cosy-v2.4.1', seed: 491377 },
  },
  {
    id: 'swm_319cb6d8', system: 'Swarm', mark: 'W', color: 'violet', title: 'Tool claim completed',
    actor: 'agent:worker-12', actorNote: 'run · 08d1…31c9', origin: 'agent', time: '12:41:19.477', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Claim token', summary: 'A worker completed an idempotent tool claim and attached its output evidence.',
    parent: 'swm_319c…11ab', parentLabel: 'Claim acquired', hash: 'sha256:1d0c72…6ee8', duration: '1.4 s', replay: 'Request and response preserved',
    proof: 'The claim token links this result to one worker and one idempotency key. It does not independently validate the tool output.',
    path: [
      { label: 'Claim acquired', note: 'Worker 12 won the lease', ms: '0 ms' },
      { label: 'Tool invoked', note: 'Arguments matched the approved claim', ms: '120 ms' },
      { label: 'Output attached', note: 'Response digest recorded', ms: '1.3 s' },
      { label: 'Claim completed', note: 'Idempotent result made available', ms: '1.4 s' },
    ],
    changes: [
      { field: 'claim.phase', before: 'running', after: 'complete' },
      { field: 'claim.attempts', before: '0', after: '1' },
    ],
    payload: { claimId: 'clm_319cb6d8', tool: 'receipt.verify', worker: 'worker-12', idempotencyKey: 'verify_rati_7f3c92a1' },
  },
  {
    id: 'sig_a9013fe2', system: 'Signal', mark: 'S', color: 'blue', title: 'Snapshot replayed',
    actor: 'replay:incident-19', actorNote: 'recording · inc-19', origin: 'replay', time: '12:40:58.771', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Replay digest', summary: 'A saved input window was replayed to compare the resulting snapshot against the original.',
    parent: 'sig_84bf…0d6e', parentLabel: 'Move committed', hash: 'sha256:02bf91…4dc8', duration: '208 ms', replay: 'Exact match',
    proof: 'The replay produced the same snapshot digest under the recorded relay version.',
    path: [
      { label: 'Recording loaded', note: 'Input window and relay version matched', ms: '0 ms' },
      { label: 'Frames replayed', note: '32 authoritative frames advanced', ms: '171 ms' },
      { label: 'Digest compared', note: 'Original and replay hashes matched', ms: '208 ms' },
    ],
    changes: [{ field: 'replay.result', before: 'running', after: 'exact-match' }],
    payload: { incident: 'incident-19', fromFrame: 91173, toFrame: 91204, expectedDigest: '02bf914dc8', result: 'exact-match' },
  },
  {
    id: 'cosy_c45d108f', system: 'CosyWorld', mark: 'C', color: 'gold', title: 'Outbox delivered',
    actor: 'system:outbox', actorNote: 'dispatcher · local', origin: 'system', time: '12:40:31.225', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Journal checksum', summary: 'The local outbox delivered a committed world event to its registered consumer.',
    parent: 'cosy_b0ee…4c21', parentLabel: 'Harvest resolved', hash: 'sha256:a55f10…7e81', duration: '26 ms', replay: 'Delivery attempt recorded',
    proof: 'The journal shows one acknowledged delivery for this event and consumer pair.',
    path: [
      { label: 'Outbox scanned', note: 'Pending event selected in order', ms: '0 ms' },
      { label: 'Consumer called', note: 'Inventory projection received event', ms: '11 ms' },
      { label: 'Delivery acknowledged', note: 'Outbox row marked delivered', ms: '26 ms' },
    ],
    changes: [{ field: 'outbox.status', before: 'pending', after: 'delivered' }],
    payload: { event: 'crop.harvested', consumer: 'inventory-projection', deliveryAttempt: 1, acknowledged: true },
  },
  {
    id: 'swm_70eb42c0', system: 'Swarm', mark: 'W', color: 'violet', title: 'Approval recorded',
    actor: 'human:operator-3', actorNote: 'session · admin-ui', origin: 'human', time: '12:39:58.441', date: '27 Aug 2026',
    integrity: 'verified', algorithm: 'Session attestation', summary: 'A human operator approved a protected action after reviewing its attached evidence.',
    parent: 'swm_6c90…1e11', parentLabel: 'Approval requested', hash: 'sha256:c83a17…2c71', duration: '3.8 s', replay: 'Decision context retained',
    proof: 'The receipt identifies the authenticated session that made the decision and the evidence digest shown at that time.',
    path: [
      { label: 'Approval opened', note: 'Evidence digest presented to operator', ms: '0 ms' },
      { label: 'Decision submitted', note: 'Authenticated session approved', ms: '3.7 s' },
      { label: 'Approval committed', note: 'Protected action released', ms: '3.8 s' },
    ],
    changes: [{ field: 'approval.state', before: 'waiting', after: 'approved' }],
    payload: { approvalId: 'apr_70eb42c0', decision: 'approved', evidenceDigest: 'c83a172c71', scope: 'protected-action' },
  },
  {
    id: 'rati_f2c4180b', system: 'Raticross', mark: 'R', color: 'coral', title: 'Envelope rejected',
    actor: 'agent:unknown-4', actorNote: 'key · unresolved', origin: 'agent', time: '12:39:21.006', date: '27 Aug 2026',
    integrity: 'review', algorithm: 'Ed25519 failed', summary: 'An envelope was rejected because its signature did not match the key declared in the header.',
    parent: 'none', parentLabel: 'No causal link', hash: 'sha256:7b9e22…1a30', duration: '9 ms', replay: 'Rejected input retained',
    proof: 'The recorded payload and signature do not verify against the declared public key. No action was applied.',
    path: [
      { label: 'Envelope received', note: 'Header parsed and schema matched', ms: '0 ms' },
      { label: 'Signature checked', note: 'Declared public key did not verify', ms: '7 ms' },
      { label: 'Envelope rejected', note: 'No downstream action was emitted', ms: '9 ms' },
    ],
    changes: [{ field: 'envelope.status', before: 'received', after: 'rejected' }],
    payload: { type: 'claim.accept', sequence: 18422, declaredActor: 'agent:unknown-4', result: 'rejected', reason: 'signature-mismatch' },
  },
];

const origins: Array<'all' | Origin> = ['all', 'human', 'agent', 'timer', 'system', 'replay'];
const systems = ['all', 'Raticross', 'Signal', 'CosyWorld', 'Swarm'] as const;

export default function Home() {
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<'all' | Origin>('all');
  const [system, setSystem] = useState<(typeof systems)[number]>('all');
  const [integrity, setIntegrity] = useState<'all' | Integrity>('all');
  const [selectedId, setSelectedId] = useState(receipts[0].id);
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState<'id' | 'json' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('receipt');
    const urlSync = window.setTimeout(() => {
      if (requested && receipts.some((receipt) => receipt.id === requested)) setSelectedId(requested);
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setRawOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(urlSync);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return receipts.filter((receipt) => {
      const searchable = `${receipt.id} ${receipt.system} ${receipt.title} ${receipt.actor} ${receipt.origin}`.toLowerCase();
      return (!needle || searchable.includes(needle))
        && (origin === 'all' || receipt.origin === origin)
        && (system === 'all' || receipt.system === system)
        && (integrity === 'all' || receipt.integrity === integrity);
    });
  }, [integrity, origin, query, system]);

  const selected = receipts.find((receipt) => receipt.id === selectedId) ?? receipts[0];
  const rawJson = JSON.stringify({
    receipt_id: selected.id,
    system: selected.system,
    actor: selected.actor,
    origin: selected.origin,
    observed_at: `${selected.date} ${selected.time} UTC`,
    integrity: { status: selected.integrity, method: selected.algorithm, payload_hash: selected.hash },
    causal_parent: selected.parent === 'none' ? null : selected.parent,
    replay: selected.replay,
    payload: selected.payload,
    changes: selected.changes,
  }, null, 2);

  function chooseReceipt(id: string) {
    setSelectedId(id);
    setRawOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set('receipt', id);
    window.history.replaceState(null, '', url);
  }

  async function copy(kind: 'id' | 'json') {
    await navigator.clipboard.writeText(kind === 'id' ? selected.id : rawJson);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1400);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><p>RATiMICS</p><span>Receipt Explorer</span></div></div>
        <div className="network-state"><span className="sample-dot" aria-hidden="true" /><span>Demo data · 4 systems</span><span className="network-time">27 AUG 2026</span></div>
        <div className="head-stats" aria-label="Demo receipt totals"><div><strong>{receipts.length}</strong><span>receipts</span></div><div><strong>{receipts.filter((r) => r.integrity === 'verified').length}</strong><span>verified</span></div></div>
      </header>

      <section className="workspace">
        <aside className="receipt-panel">
          <div className="panel-heading"><div><p className="eyebrow">Sample ledger</p><h1>Receipts</h1></div><span className="demo-badge">Adapter-ready</span></div>
          <label className="search"><span aria-hidden="true">⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search receipts" placeholder="Search actor, receipt, or action" /><kbd>⌘ K</kbd></label>
          <div className="filter-selects">
            <label><span>System</span><select value={system} onChange={(event) => setSystem(event.target.value as (typeof systems)[number])}>{systems.map((item) => <option key={item} value={item}>{item === 'all' ? 'All systems' : item}</option>)}</select></label>
            <label><span>Integrity</span><select value={integrity} onChange={(event) => setIntegrity(event.target.value as 'all' | Integrity)}><option value="all">Any result</option><option value="verified">Verified</option><option value="review">Needs review</option></select></label>
          </div>
          <div className="filters" aria-label="Origin filters">
            {origins.map((item) => <button className={`filter ${origin === item ? 'active' : ''}`} type="button" aria-pressed={origin === item} onClick={() => setOrigin(item)} key={item}>{item[0].toUpperCase() + item.slice(1)} <span>{item === 'all' ? receipts.length : receipts.filter((receipt) => receipt.origin === item).length}</span></button>)}
          </div>
          <div className="list-labels"><span>Latest</span><span>{filtered.length} shown</span></div>
          <div className="receipt-list">
            {filtered.length ? filtered.map((receipt) => (
              <button type="button" aria-pressed={selected.id === receipt.id} onClick={() => chooseReceipt(receipt.id)} className={`receipt-row ${selected.id === receipt.id ? 'selected' : ''}`} key={receipt.id}>
                <span className={`system-mark ${receipt.color}`}>{receipt.mark}</span>
                <span className="row-copy"><span className="row-title"><strong>{receipt.title}</strong><span>{receipt.time}</span></span><span className="row-meta"><span>{receipt.system}</span><code>{receipt.id}</code></span><span className="row-foot"><span>{receipt.actor}</span><span className={`origin ${receipt.origin}`}>{receipt.origin}</span></span></span>
                <span className={`verified ${receipt.integrity === 'review' ? 'warning' : ''}`} title={receipt.integrity === 'verified' ? 'Verified' : 'Needs review'} aria-label={receipt.integrity === 'verified' ? 'Verified' : 'Needs review'}>{receipt.integrity === 'verified' ? '✓' : '!'}</span>
              </button>
            )) : <div className="empty-state"><strong>No matching receipts</strong><span>Clear a filter or try another search.</span><button type="button" onClick={() => { setQuery(''); setOrigin('all'); setSystem('all'); setIntegrity('all'); }}>Clear filters</button></div>}
          </div>
        </aside>

        <section className="detail-panel" aria-labelledby="receipt-title">
          <div className="detail-top"><div className="crumb"><span>{selected.system}</span><span>/</span><code>{selected.id}</code></div><div className="detail-actions"><button type="button" onClick={() => copy('id')}>{copied === 'id' ? 'Copied' : 'Copy ID'}</button><button className={rawOpen ? 'active' : ''} type="button" aria-pressed={rawOpen} onClick={() => setRawOpen((open) => !open)}>{rawOpen ? 'Overview' : 'Raw JSON'}</button></div></div>

          <div className="receipt-hero"><div><p className="eyebrow">{selected.integrity === 'verified' ? 'Recorded action receipt' : 'Rejected action receipt'}</p><h2 id="receipt-title">{selected.title}</h2><p>{selected.summary}</p></div><div className={`seal ${selected.integrity === 'review' ? 'review' : ''}`}><span>{selected.integrity === 'verified' ? '✓' : '!'}</span><strong>{selected.integrity === 'verified' ? 'Verified' : 'Review'}</strong><small>{selected.algorithm}</small></div></div>

          <div className="facts"><div><span>Actor</span><strong>{selected.actor}</strong><small>{selected.actorNote}</small></div><div><span>Origin</span><strong>{selected.origin}</strong><small>{selected.system} event</small></div><div><span>Observed</span><strong>{selected.time} UTC</strong><small>{selected.date}</small></div><div><span>Causal parent</span><strong>{selected.parent}</strong><small>{selected.parentLabel}</small></div></div>

          {rawOpen ? (
            <section className="raw-card" aria-label="Raw receipt JSON"><div className="card-title"><h3>Normalized receipt</h3><button type="button" onClick={() => copy('json')}>{copied === 'json' ? 'Copied' : 'Copy JSON'}</button></div><pre><code>{rawJson}</code></pre></section>
          ) : (
            <div className="detail-grid">
              <section className="card timeline-card"><div className="card-title"><h3>Receipt path</h3><span>{selected.duration} total</span></div><ol className="timeline">{selected.path.map((step) => <li key={step.label}><span /><div><strong>{step.label}</strong><small>{step.note}</small></div><time>{step.ms}</time></li>)}</ol></section>
              <section className="card change-card"><div className="card-title"><h3>State change</h3><span className="change-count">{selected.changes.length} {selected.changes.length === 1 ? 'field' : 'fields'}</span></div>{selected.changes.map((change) => <div className="diff-row" key={change.field}><span>{change.field}</span><code className="before">{change.before}</code><b>→</b><code className="after">{change.after}</code></div>)}<div className="hash-line"><span>Payload hash</span><code>{selected.hash}</code><button type="button" onClick={() => copy('json')} aria-label="Copy receipt evidence">⧉</button></div><div className="replay-line"><span>Replay</span><strong>{selected.replay}</strong></div></section>
            </div>
          )}

          <footer className={`evidence-note ${selected.integrity === 'review' ? 'review' : ''}`}><span className="evidence-icon">i</span><p><strong>What this proves</strong><br />{selected.proof}</p></footer>
        </section>
      </section>
    </main>
  );
}
