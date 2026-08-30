'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Integrity,
  Origin,
  Receipt,
  ReceiptFeed,
  SourceStatus,
  SystemName,
} from './receipt-types';
import { SYSTEMS } from './receipt-types';

const demoReceipts: Receipt[] = [
  {
    id: 'demo_rati_7f3c92a1', system: 'Raticross', mark: 'R', color: 'coral', title: 'Envelope accepted',
    actor: 'agent:cenetex', actorNote: 'sample key · 3bc2…91a7', origin: 'agent', time: '12:42:18', date: '27 Aug 2026', observedAt: '2026-08-27T12:42:18.084Z',
    integrity: 'recorded', algorithm: 'Boundary log', summary: 'A sample agent request crossed the Raticross boundary.',
    parent: 'demo_swm_8b19', parentLabel: 'Sample tool claim', hash: 'sample:af42d8…c930', duration: '84 ms', replay: 'Sample input captured',
    proof: 'Demo only. The real Raticross bridge records boundary events, but it does not yet expose a canonical signed receipt journal.',
    path: [
      { label: 'Request created', note: 'Sample envelope assembled', ms: '0 ms' },
      { label: 'Boundary crossed', note: 'Sample relay accepted the request', ms: '17 ms' },
      { label: 'Record normalized', note: 'Explorer adapter produced this demo', ms: '84 ms' },
    ],
    changes: [{ field: 'envelope.status', before: 'pending', after: 'accepted' }],
    payload: { demo: true, type: 'claim.accept', result: 'accepted' },
  },
  {
    id: 'demo_sig_84bf0d6e', system: 'Signal', mark: 'S', color: 'blue', title: 'Chain receipt derived',
    actor: 'station:7wX…3ca', actorNote: 'sample station', origin: 'system', time: '12:41:56', date: '27 Aug 2026', observedAt: '2026-08-27T12:41:56.913Z',
    integrity: 'verified', algorithm: 'Ed25519 chain log', summary: 'A sample receipt derived from a verified Signal station chain.',
    parent: 'sample:983c4a…71bb', parentLabel: 'Previous sample event hash', hash: 'sample:02bf91…4dc8', duration: '43 ms', replay: 'Sample chain retained',
    proof: 'Demo only. Signal’s real receipt tool verifies the append-only chain and station signature before it emits JSON.',
    path: [
      { label: 'Chain opened', note: 'Sample station log selected', ms: '0 ms' },
      { label: 'Signature checked', note: 'Sample station signature matched', ms: '31 ms' },
      { label: 'Receipt derived', note: 'Deterministic sample JSON emitted', ms: '43 ms' },
    ],
    changes: [],
    payload: { demo: true, schema: 'signal.rati_mining_receipts.v1', station_signature_verified: true },
  },
  {
    id: 'demo_cosy_b0ee4c21', system: 'CosyWorld', mark: 'C', color: 'gold', title: 'Harvest resolved',
    actor: 'timer:world-tick', actorNote: 'sample sequence · 8421', origin: 'timer', time: 'SEQ 8421', date: 'Canonical order', observedAt: null,
    integrity: 'recorded', algorithm: 'SQLite action journal', summary: 'A sample deterministic world action was committed to the journal.',
    parent: 'demo_cosy_8420', parentLabel: 'Sample previous event', hash: 'not emitted', duration: '12 ms', replay: 'Sample command retained',
    proof: 'Demo only. The real CosyWorld journal provides canonical order and durable replay, but its event feed does not emit cryptographic signatures.',
    path: [
      { label: 'Command selected', note: 'Sample harvest rule matched', ms: '0 ms' },
      { label: 'Kernel advanced', note: 'Sample transition completed', ms: '8 ms' },
      { label: 'Journal committed', note: 'Sample sequence assigned', ms: '12 ms' },
    ],
    changes: [{ field: 'inventory.turnip', before: '8', after: '9' }],
    payload: { demo: true, type: 'harvest', seq: 8421, success: true },
  },
  {
    id: 'demo_swm_319cb6d8', system: 'Swarm', mark: 'W', color: 'violet', title: 'Tool activity recorded',
    actor: 'avatar:worker-12', actorNote: 'sample activity item', origin: 'agent', time: '12:41:19', date: '27 Aug 2026', observedAt: '2026-08-27T12:41:19.477Z',
    integrity: 'recorded', algorithm: 'DynamoDB activity log', summary: 'A sample worker activity record was read from Swarm’s evidence shape.',
    parent: 'demo_swm_claim', parentLabel: 'Sample request', hash: 'sample:1d0c72…6ee8', duration: '1.4 s', replay: 'Sample request retained',
    proof: 'Demo only. Swarm’s real audit and activity stores are operational records, not cryptographic attestations.',
    path: [
      { label: 'Activity emitted', note: 'Sample worker finished a claim', ms: '0 ms' },
      { label: 'Evidence stored', note: 'Sample record entered the activity store', ms: '1.3 s' },
      { label: 'Receipt normalized', note: 'Explorer preserved the source proof level', ms: '1.4 s' },
    ],
    changes: [{ field: 'claim.phase', before: 'running', after: 'complete' }],
    payload: { demo: true, type: 'activity', event: 'claim_completed' },
  },
];

const origins: Array<'all' | Origin> = ['all', 'human', 'agent', 'timer', 'system', 'replay'];
const systems: Array<'all' | SystemName> = ['all', ...SYSTEMS];
const integrityResults: Array<'all' | Integrity> = ['all', 'verified', 'recorded', 'review'];

const initialSources: SourceStatus[] = SYSTEMS.map((system) => ({
  system,
  state: 'unconfigured',
  detail: 'Checking source configuration…',
  receiptCount: 0,
}));

function isReceiptFeed(value: unknown): value is ReceiptFeed {
  if (!value || typeof value !== 'object') return false;
  const feed = value as Partial<ReceiptFeed>;
  return feed.mode === 'live' && Array.isArray(feed.receipts) && Array.isArray(feed.sources);
}

function integrityLabel(value: Integrity): string {
  if (value === 'verified') return 'Verified';
  if (value === 'recorded') return 'Recorded';
  return 'Review';
}

export default function Home() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>(initialSources);
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<'all' | Origin>('all');
  const [system, setSystem] = useState<'all' | SystemName>('all');
  const [integrity, setIntegrity] = useState<'all' | Integrity>('all');
  const [selectedId, setSelectedId] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState<'id' | 'json' | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchLive = useCallback(async () => {
    try {
      const response = await fetch('/api/receipts', { cache: 'no-store' });
      if (!response.ok) throw new Error('Receipt feed unavailable');
      const body: unknown = await response.json();
      if (!isReceiptFeed(body)) throw new Error('Invalid receipt feed');
      setReceipts(body.receipts);
      setSources(body.sources);
      setGeneratedAt(body.generatedAt);
      setFeedError(false);
      setSelectedId((current) => body.receipts.some((item) => item.id === current) ? current : body.receipts[0]?.id ?? '');
    } catch {
      setReceipts([]);
      setSources(SYSTEMS.map((sourceSystem) => ({
        system: sourceSystem,
        state: 'error',
        detail: 'The protected receipt feed could not be reached.',
        receiptCount: 0,
      })));
      setFeedError(true);
      setSelectedId('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const useDemo = params.get('demo') === '1';
      const requested = params.get('receipt');
      setDemoMode(useDemo);
      if (useDemo) {
        setReceipts(demoReceipts);
        setSources(SYSTEMS.map((sourceSystem) => ({
          system: sourceSystem,
          state: 'empty',
          detail: 'Demo mode; the live source was not queried.',
          receiptCount: 1,
        })));
        setSelectedId(requested && demoReceipts.some((item) => item.id === requested) ? requested : demoReceipts[0].id);
        setGeneratedAt(null);
        setLoading(false);
      } else {
        void fetchLive();
      }
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
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fetchLive]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return receipts.filter((receipt) => {
      const searchable = `${receipt.id} ${receipt.system} ${receipt.title} ${receipt.actor} ${receipt.origin}`.toLowerCase();
      return (!needle || searchable.includes(needle))
        && (origin === 'all' || receipt.origin === origin)
        && (system === 'all' || receipt.system === system)
        && (integrity === 'all' || receipt.integrity === integrity);
    });
  }, [integrity, origin, query, receipts, system]);

  const selected = receipts.find((receipt) => receipt.id === selectedId) ?? receipts[0] ?? null;
  const liveSources = sources.filter((source) => source.state === 'live' || source.state === 'empty').length;
  const verifiedCount = receipts.filter((receipt) => receipt.integrity === 'verified').length;
  const rawJson = selected ? JSON.stringify({
    receipt_id: selected.id,
    system: selected.system,
    actor: selected.actor,
    origin: selected.origin,
    observed_at: selected.observedAt,
    display_order: selected.observedAt ? null : `${selected.date} ${selected.time}`,
    integrity: { status: selected.integrity, method: selected.algorithm, payload_hash: selected.hash },
    causal_parent: selected.parent === 'none' ? null : selected.parent,
    replay: selected.replay,
    payload: selected.payload,
    changes: selected.changes,
  }, null, 2) : '';

  function chooseReceipt(id: string) {
    setSelectedId(id);
    setRawOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set('receipt', id);
    window.history.replaceState(null, '', url);
  }

  async function copy(kind: 'id' | 'json') {
    if (!selected) return;
    await navigator.clipboard.writeText(kind === 'id' ? selected.id : rawJson);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1400);
  }

  function showDemo() {
    const url = new URL(window.location.href);
    url.searchParams.set('demo', '1');
    url.searchParams.delete('receipt');
    window.history.replaceState(null, '', url);
    setDemoMode(true);
    setReceipts(demoReceipts);
    setSources(SYSTEMS.map((sourceSystem) => ({
      system: sourceSystem,
      state: 'empty',
      detail: 'Demo mode; the live source was not queried.',
      receiptCount: 1,
    })));
    setGeneratedAt(null);
    setSelectedId(demoReceipts[0].id);
    setLoading(false);
    setFeedError(false);
  }

  function showLive() {
    const url = new URL(window.location.href);
    url.searchParams.delete('demo');
    url.searchParams.delete('receipt');
    window.history.replaceState(null, '', url);
    setDemoMode(false);
    setLoading(true);
    setSelectedId('');
    void fetchLive();
  }

  function clearFilters() {
    setQuery('');
    setOrigin('all');
    setSystem('all');
    setIntegrity('all');
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><p>RATiMICS</p><span>Receipt Explorer</span></div></div>
        <div className="network-state">
          <span className={`sample-dot ${demoMode ? 'demo' : liveSources ? 'live' : ''}`} aria-hidden="true" />
          <span>{demoMode ? 'Demo mode · 4 samples' : loading ? 'Checking real sources' : `${liveSources} of 4 sources connected`}</span>
          <span className="network-time">{generatedAt ? `READ ${new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'NO CACHE'}</span>
        </div>
        <div className="head-stats" aria-label="Receipt totals"><div><strong>{receipts.length}</strong><span>receipts</span></div><div><strong>{verifiedCount}</strong><span>verified</span></div></div>
      </header>

      <section className="workspace">
        <aside className="receipt-panel">
          <div className="panel-heading"><div><p className="eyebrow">{demoMode ? 'Clearly marked samples' : 'Protected live feed'}</p><h1>Receipts</h1></div><button className="mode-button" type="button" onClick={demoMode ? showLive : showDemo}>{demoMode ? 'Return to live' : 'View demo'}</button></div>

          <div className="source-grid" aria-label="Source connection status">
            {sources.map((source) => (
              <div className={`source-chip ${source.state}`} title={source.detail} key={source.system}>
                <span /><div><strong>{source.system}</strong><small>{source.state === 'live' ? `${source.receiptCount} live` : source.state}</small></div>
              </div>
            ))}
          </div>

          <label className="search"><span aria-hidden="true">⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search receipts" placeholder="Search actor, receipt, or action" /><kbd>⌘ K</kbd></label>
          <div className="filter-selects">
            <label><span>System</span><select value={system} onChange={(event) => setSystem(event.target.value as 'all' | SystemName)}>{systems.map((item) => <option key={item} value={item}>{item === 'all' ? 'All systems' : item}</option>)}</select></label>
            <label><span>Evidence</span><select value={integrity} onChange={(event) => setIntegrity(event.target.value as 'all' | Integrity)}>{integrityResults.map((item) => <option key={item} value={item}>{item === 'all' ? 'Any result' : integrityLabel(item)}</option>)}</select></label>
          </div>
          <div className="filters" aria-label="Origin filters">
            {origins.map((item) => <button className={`filter ${origin === item ? 'active' : ''}`} type="button" aria-pressed={origin === item} onClick={() => setOrigin(item)} key={item}>{item[0].toUpperCase() + item.slice(1)} <span>{item === 'all' ? receipts.length : receipts.filter((receipt) => receipt.origin === item).length}</span></button>)}
          </div>
          <div className="list-labels"><span>Latest</span><span>{loading ? 'loading' : `${filtered.length} shown`}</span></div>
          <div className="receipt-list">
            {filtered.length ? filtered.map((receipt) => (
              <button type="button" aria-pressed={selected?.id === receipt.id} onClick={() => chooseReceipt(receipt.id)} className={`receipt-row ${selected?.id === receipt.id ? 'selected' : ''}`} key={receipt.id}>
                <span className={`system-mark ${receipt.color}`}>{receipt.mark}</span>
                <span className="row-copy"><span className="row-title"><strong>{receipt.title}</strong><span>{receipt.time}</span></span><span className="row-meta"><span>{receipt.system}</span><code>{receipt.id}</code></span><span className="row-foot"><span>{receipt.actor}</span><span className={`origin ${receipt.origin}`}>{receipt.origin}</span></span></span>
                <span className={`verified ${receipt.integrity}`} title={integrityLabel(receipt.integrity)} aria-label={integrityLabel(receipt.integrity)}>{receipt.integrity === 'verified' ? '✓' : receipt.integrity === 'recorded' ? '•' : '!'}</span>
              </button>
            )) : (
              <div className="empty-state">
                <strong>{loading ? 'Reading protected sources…' : receipts.length ? 'No matching receipts' : 'No real receipts connected'}</strong>
                <span>{loading ? 'This normally takes a few seconds.' : receipts.length ? 'Clear a filter or try another search.' : 'Open the source panel for the exact connection state.'}</span>
                {!loading && <button type="button" onClick={receipts.length ? clearFilters : showDemo}>{receipts.length ? 'Clear filters' : 'View marked demo'}</button>}
              </div>
            )}
          </div>
        </aside>

        <section className="detail-panel" aria-labelledby={selected ? 'receipt-title' : undefined}>
          {selected ? (
            <>
              <div className="detail-top"><div className="crumb"><span>{selected.system}</span><span>/</span><code>{selected.id}</code></div><div className="detail-actions"><button type="button" onClick={() => copy('id')}>{copied === 'id' ? 'Copied' : 'Copy ID'}</button><button className={rawOpen ? 'active' : ''} type="button" aria-pressed={rawOpen} onClick={() => setRawOpen((open) => !open)}>{rawOpen ? 'Overview' : 'Raw JSON'}</button></div></div>

              <div className="receipt-hero"><div><p className="eyebrow">{demoMode ? 'Demo receipt · not live' : `${integrityLabel(selected.integrity)} source evidence`}</p><h2 id="receipt-title">{selected.title}</h2><p>{selected.summary}</p></div><div className={`seal ${selected.integrity}`}><span>{selected.integrity === 'verified' ? '✓' : selected.integrity === 'recorded' ? '•' : '!'}</span><strong>{integrityLabel(selected.integrity)}</strong><small>{selected.algorithm}</small></div></div>

              <div className="facts"><div><span>Actor</span><strong>{selected.actor}</strong><small>{selected.actorNote}</small></div><div><span>Origin</span><strong>{selected.origin}</strong><small>{selected.system} event</small></div><div><span>{selected.observedAt ? 'Observed' : 'Order'}</span><strong>{selected.time}{selected.observedAt ? ' UTC' : ''}</strong><small>{selected.date}</small></div><div><span>Causal parent</span><strong>{selected.parent}</strong><small>{selected.parentLabel}</small></div></div>

              {rawOpen ? (
                <section className="raw-card" aria-label="Raw receipt JSON"><div className="card-title"><h3>Normalized receipt</h3><button type="button" onClick={() => copy('json')}>{copied === 'json' ? 'Copied' : 'Copy JSON'}</button></div><pre><code>{rawJson}</code></pre></section>
              ) : (
                <div className="detail-grid">
                  <section className="card timeline-card"><div className="card-title"><h3>Receipt path</h3><span>{selected.duration} total</span></div><ol className="timeline">{selected.path.map((step) => <li key={`${step.label}-${step.ms}`}><span /><div><strong>{step.label}</strong><small>{step.note}</small></div><time>{step.ms}</time></li>)}</ol></section>
                  <section className="card change-card"><div className="card-title"><h3>State change</h3><span className="change-count">{selected.changes.length ? `${selected.changes.length} ${selected.changes.length === 1 ? 'field' : 'fields'}` : 'not emitted'}</span></div>{selected.changes.length ? selected.changes.map((change) => <div className="diff-row" key={change.field}><span>{change.field}</span><code className="before">{change.before}</code><b>→</b><code className="after">{change.after}</code></div>) : <p className="missing-proof">This source did not emit a structured before/after diff.</p>}<div className="hash-line"><span>Payload hash</span><code>{selected.hash}</code><button type="button" onClick={() => copy('json')} aria-label="Copy receipt evidence">⧉</button></div><div className="replay-line"><span>Replay</span><strong>{selected.replay}</strong></div></section>
                </div>
              )}

              <footer className={`evidence-note ${selected.integrity}`}><span className="evidence-icon">i</span><p><strong>What this proves</strong><br />{selected.proof}</p></footer>
            </>
          ) : (
            <div className="source-empty">
              <p className="eyebrow">Real data, honestly reported</p>
              <h2>{feedError ? 'Receipt feed unavailable' : loading ? 'Reading evidence sources' : 'Connect a source to begin'}</h2>
              <p>{feedError ? 'The site could not reach its protected server route. Retry to check it again.' : loading ? 'The explorer is asking each configured source for bounded, sanitized evidence.' : 'The adapters are built. Add each source URL and server token in the private site settings; samples never appear unless you choose demo mode.'}</p>
              <div className="source-cards">
                {sources.map((source) => <article className={source.state} key={source.system}><div><span /><strong>{source.system}</strong></div><small>{source.detail}</small></article>)}
              </div>
              <div className="empty-actions"><button type="button" onClick={() => { setLoading(true); void fetchLive(); }}>Retry live feed</button><button type="button" onClick={showDemo}>View marked demo</button></div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
