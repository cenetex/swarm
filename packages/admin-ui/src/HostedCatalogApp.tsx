import { useEffect, useMemo, useState } from 'react';
import {
  getPublicHostedAvatar,
  listPublicHostedAvatars,
  publicHostedAvatarBundleUrl,
  publicHostedAvatarNftMetadataUrl,
  type PublicHostedAvatar,
  type PublicHostedAvatarProject,
} from './hosted-api';

function avatarMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase())
      .join('') || '∴'
  );
}

function setPageMetadata(title: string, description: string, preserveSocialImage = true): void {
  document.title = title;
  const selectors = [
    'meta[name="description"]',
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[name="twitter:title"]',
    'meta[name="twitter:description"]',
  ];
  const values = [description, title, description, title, description];
  selectors.forEach((selector, index) => {
    let element = document.head.querySelector<HTMLMetaElement>(selector);
    if (!element) {
      element = document.createElement('meta');
      const property = selector.match(/property="([^"]+)/u)?.[1];
      const name = selector.match(/name="([^"]+)/u)?.[1];
      if (property) element.setAttribute('property', property);
      if (name) element.setAttribute('name', name);
      document.head.appendChild(element);
    }
    element.content = values[index] ?? '';
  });
  if (!preserveSocialImage) {
    document.head.querySelector('meta[property="og:image"]')?.remove();
    document.head.querySelector('meta[name="twitter:image"]')?.remove();
  }
}

function CatalogHeader() {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur">
      <div className="flex h-16 w-full items-center justify-between gap-4 px-4 sm:px-8">
        <a href="/" className="flex min-w-0 items-center gap-3" aria-label="Swarm catalog home">
          <img src="/swarm.svg" alt="" className="h-8 w-8 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-wide">SWARM</p>
            <p className="hidden text-[0.65rem] uppercase tracking-[0.2em] text-[var(--color-text-muted)] sm:block">
              Companions
            </p>
          </div>
        </a>
        <nav className="flex items-center gap-2" aria-label="Primary navigation">
          <a
            href="/"
            aria-current={window.location.pathname === '/' ? 'page' : undefined}
            className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            Discover
          </a>
          <a
            href="/studio"
            className="rounded-lg border border-brand-400/60 bg-brand-500/10 px-3 py-2 text-sm font-semibold text-brand-200 transition hover:bg-brand-500/20"
          >
            Open Studio
          </a>
        </nav>
      </div>
    </header>
  );
}

function CatalogCard({ avatar }: { avatar: PublicHostedAvatar }) {
  const colors = [
    'bg-brand-500/20 text-brand-100',
    'bg-teal-500/20 text-teal-200',
    'bg-amber-500/20 text-amber-200',
    'bg-sky-500/20 text-sky-200',
  ];
  const color =
    colors[Array.from(avatar.avatarId).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length];
  return (
    <a
      href={`/a/${avatar.slug}`}
      className="group flex min-h-64 flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 transition hover:-translate-y-0.5 hover:border-brand-400/70 hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-400"
    >
      <div className="flex items-start justify-between gap-4">
        <div className={'grid h-14 w-14 place-items-center rounded-2xl text-lg font-semibold ' + color}>
          {avatarMonogram(avatar.name)}
        </div>
        <span className="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          Public
        </span>
      </div>
      <h2 className="mt-6 text-xl font-semibold tracking-tight group-hover:text-brand-100">{avatar.name}</h2>
      <p className="mt-2 line-clamp-3 flex-1 text-base leading-7 text-[var(--color-text-secondary)]">
        {avatar.description || 'A companion ready for a new conversation.'}
      </p>
      <div className="mt-6 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4 text-sm font-medium text-brand-200">
        <span>Meet {avatar.name}</span>
        <span aria-hidden="true">→</span>
      </div>
    </a>
  );
}

function CatalogIndex() {
  const [avatars, setAvatars] = useState<PublicHostedAvatar[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setPageMetadata('Swarm — Public avatar registry', 'Discover portable, public AI projects on Swarm.');
    let active = true;
    listPublicHostedAvatars()
      .then((result) => {
        if (active) setAvatars(result);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load the public registry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleAvatars = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return avatars;
    return avatars.filter((avatar) => `${avatar.name} ${avatar.description}`.toLowerCase().includes(normalized));
  }, [avatars, query]);

  return (
    <div className="hosted-catalog min-h-[100dvh] w-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <CatalogHeader />
      <main className="mx-auto w-full max-w-[110rem] px-4 py-10 sm:px-8 sm:py-14">
        <section aria-labelledby="catalog-heading" className="border-b border-[var(--color-border)] pb-8">
          <p className="text-sm font-medium text-brand-200">Find your next companion</p>
          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
            <div>
              <h1
                id="catalog-heading"
                className="max-w-3xl text-4xl font-semibold leading-tight tracking-[-0.035em] sm:text-5xl"
              >
                Good company. Great conversations.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--color-text-secondary)]">
                Meet a companion. Bring it into your Studio. Start talking.
              </p>
            </div>
            <div>
              <label
                htmlFor="catalog-search"
                className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]"
              >
                Find a companion
              </label>
              <input
                id="catalog-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or purpose"
                className="mt-2 w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] px-4 py-3 text-base outline-none transition placeholder:text-[var(--color-text-muted)] focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
              />
            </div>
          </div>
        </section>

        <section aria-label="Public avatars" className="py-8">
          <div className="mb-5 flex items-center justify-between gap-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {loading
                ? 'Reading the registry…'
                : `${visibleAvatars.length} public ${visibleAvatars.length === 1 ? 'avatar' : 'avatars'}`}
            </p>
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-lg px-3 py-2 text-sm font-medium text-brand-200 hover:bg-[var(--color-bg-secondary)]"
              >
                Clear search
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="border border-red-400/30 bg-red-400/5 p-5 text-sm text-red-200">
              {error}
            </div>
          )}
          {!loading && !error && visibleAvatars.length === 0 && (
            <div className="border border-dashed border-[var(--color-border-secondary)] px-6 py-16 text-center">
              <h2 className="text-xl font-semibold">
                {avatars.length ? 'Try another name or purpose' : 'Meet the first companion'}
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--color-text-secondary)]">
                {avatars.length
                  ? 'Browse all companions to find a new starting point.'
                  : 'Create a companion in Studio. Give it a name and start a conversation.'}
              </p>
              {!avatars.length && (
                <a
                  href="/studio"
                  className="mt-6 inline-flex border border-brand-400/60 px-4 py-2.5 text-sm font-semibold text-brand-200"
                >
                  Create the first avatar
                </a>
              )}
              {avatars.length > 0 && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-6 rounded-xl bg-brand-500 px-5 py-3 text-base font-semibold text-white"
                >
                  Show all companions
                </button>
              )}
            </div>
          )}
          {visibleAvatars.length > 0 && (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {visibleAvatars.map((avatar) => (
                <CatalogCard key={avatar.avatarId} avatar={avatar} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function AvatarProject({ slug }: { slug: string }) {
  const [project, setProject] = useState<PublicHostedAvatarProject | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getPublicHostedAvatar(slug)
      .then((result) => {
        if (!active) return;
        setProject(result);
        setPageMetadata(`${result.name} — Swarm`, result.description || `Explore ${result.name} on Swarm.`, false);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load this public avatar.');
      });
    return () => {
      active = false;
    };
  }, [slug]);

  return (
    <div className="hosted-catalog min-h-[100dvh] w-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <CatalogHeader />
      <main className="mx-auto w-full max-w-[110rem] px-4 py-10 sm:px-8 sm:py-14">
        <a href="/" className="text-sm text-brand-300 hover:text-brand-200">
          ← Back to registry
        </a>
        {error && (
          <div role="alert" className="mt-8 border border-red-400/30 bg-red-400/5 p-5 text-red-200">
            {error}
          </div>
        )}
        {!error && !project && <p className="mt-8 text-sm text-[var(--color-text-muted)]">Reading avatar project…</p>}
        {project && (
          <article className="mt-8">
            <div className="grid gap-8 border-b border-[var(--color-border)] pb-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div>
                <div className="flex items-center gap-3">
                  <div className="grid h-16 w-16 place-items-center border border-brand-400/40 bg-brand-500/10 font-mono text-xl text-brand-200">
                    {avatarMonogram(project.name)}
                  </div>
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Public project
                  </span>
                </div>
                <h1 className="mt-6 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">{project.name}</h1>
                <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--color-text-secondary)]">
                  {project.description || 'An open Swarm avatar project.'}
                </p>
              </div>
              <div className="space-y-3 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
                <a
                  href={'/studio?companion=' + encodeURIComponent(project.slug)}
                  className="block w-full rounded-xl bg-brand-500 px-4 py-3 text-center text-base font-semibold text-white hover:bg-brand-600"
                >
                  Open in Studio
                </a>
                <a
                  href={publicHostedAvatarBundleUrl(project.slug)}
                  className="block w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-center text-sm font-semibold hover:bg-[var(--color-bg-tertiary)]"
                >
                  Download portable avatar
                </a>
                <p className="pt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                  Add your own copy, then start a conversation.
                </p>
              </div>
            </div>

            <div className="grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="space-y-8">
                <section aria-labelledby="public-prompt-heading">
                  <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-brand-300">Public prompt</p>
                  <h2 id="public-prompt-heading" className="mt-2 text-2xl font-semibold">
                    How this mind begins
                  </h2>
                  {project.bundle.prompts.system.length > 400 ? (
                    <details className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-4">
                      <summary className="cursor-pointer text-base font-medium text-brand-200">
                        Read the full prompt
                      </summary>
                      <p className="mt-4 whitespace-pre-wrap break-words text-base leading-7 text-[var(--color-text-secondary)]">
                        {project.bundle.prompts.system}
                      </p>
                    </details>
                  ) : (
                    <p className="mt-4 whitespace-pre-wrap break-words border-l-2 border-brand-400 px-5 py-4 text-base leading-7 text-[var(--color-text-secondary)]">
                      {project.bundle.prompts.system || 'Ready for a new direction.'}
                    </p>
                  )}
                </section>
                <section aria-labelledby="memory-heading">
                  <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-brand-300">Shared memory</p>
                  <h2 id="memory-heading" className="mt-2 text-2xl font-semibold">
                    What it carries forward
                  </h2>
                  <p className="mt-4 text-sm leading-7 text-[var(--color-text-secondary)]">
                    {project.bundle.sharedMemory.summary || 'This revision has no shared memory summary yet.'}
                  </p>
                </section>
              </div>
              <aside
                aria-label="Avatar manifest"
                className="h-fit border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5"
              >
                <details>
                  <summary className="cursor-pointer text-base font-semibold">Project details</summary>
                  <dl className="mt-4 space-y-4 text-xs">
                    <div>
                      <dt className="text-[var(--color-text-muted)]">Controller</dt>
                      <dd className="mt-1 break-all font-mono text-[var(--color-text-secondary)]">
                        {project.controller}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-text-muted)]">Revision</dt>
                      <dd className="mt-1 break-all font-mono text-[var(--color-text-secondary)]">
                        {project.revisionId}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-text-muted)]">Schema</dt>
                      <dd className="mt-1 font-mono text-[var(--color-text-secondary)]">{project.bundle.schema}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-text-muted)]">Capabilities</dt>
                      <dd className="mt-1 text-[var(--color-text-secondary)]">
                        {project.bundle.capabilities.map((capability) => capability.name).join(', ') || 'None declared'}
                      </dd>
                    </div>
                  </dl>
                  <a
                    href={publicHostedAvatarNftMetadataUrl(project.slug)}
                    className="mt-5 inline-block text-sm text-brand-200 underline"
                  >
                    View NFT metadata
                  </a>
                </details>
              </aside>
            </div>
          </article>
        )}
      </main>
    </div>
  );
}

export function HostedCatalogApp() {
  const match = window.location.pathname.match(/^\/a\/([^/]+)\/?$/u);
  return match ? <AvatarProject slug={decodeURIComponent(match[1] ?? '')} /> : <CatalogIndex />;
}
