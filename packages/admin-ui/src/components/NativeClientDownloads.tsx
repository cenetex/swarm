const releaseUrl = 'https://github.com/atimics/swarm/releases/latest';

const downloads = [
  { label: 'macOS', href: releaseUrl },
  { label: 'Windows', href: releaseUrl },
  { label: 'Linux', href: releaseUrl },
];

export function NativeClientDownloads() {
  return (
    <div className="mt-4 max-w-3xl mx-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-4 text-left">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--color-text)]">Native clients</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            The web client stores everything in this browser. Use desktop when you want encrypted local secrets, process launch, and runtime supervision.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {downloads.map((download) => (
            <a
              key={download.label}
              href={download.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-1.5 text-xs font-medium text-brand-300 transition-colors hover:bg-brand-500/20"
            >
              {download.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
