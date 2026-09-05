import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedCatalogApp } from './HostedCatalogApp';
import * as hostedApi from './hosted-api';

vi.mock('./hosted-api', async () => {
  const actual = await vi.importActual<typeof import('./hosted-api')>('./hosted-api');
  return {
    ...actual,
    listPublicHostedAvatars: vi.fn(),
    getPublicHostedAvatar: vi.fn(),
  };
});

const revisionId = `sha256:${'a'.repeat(64)}`;
const summary = {
  avatarId: 'avatar-public-ada',
  slug: 'public-ada-1234',
  name: 'Public Ada',
  description: 'An open research mind.',
  visibility: 'public' as const,
  listed: true,
  revisionId,
  controller: '11111111111111111111111111111111',
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.mocked(hostedApi.listPublicHostedAvatars).mockResolvedValue([summary]);
  vi.mocked(hostedApi.getPublicHostedAvatar).mockResolvedValue({
    ...summary,
    sha256: 'a'.repeat(64),
    bundle: {
      schema: 'swarm.avatar/v1',
      identity: {
        avatarId: summary.avatarId,
        slug: summary.slug,
        name: summary.name,
        description: summary.description,
        controller: { type: 'solana-wallet', address: summary.controller },
      },
      publication: { visibility: 'public', listed: true },
      prompts: { system: 'Think carefully in public.', starters: [] },
      capabilities: [{ id: 'conversation', name: 'Conversation' }],
      sharedMemory: { summary: 'Research notes shared by the project.', entries: [] },
      media: [],
      lineage: {},
      revision: { createdAt: '2026-08-30T12:00:00.000Z' },
    },
  });
});

describe('HostedCatalogApp', () => {
  it('shows public avatars as the anonymous root experience', async () => {
    render(<HostedCatalogApp />);

    expect(screen.getByRole('heading', { name: /good company/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Public Ada' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /public ada/i })).toHaveAttribute('href', '/a/public-ada-1234');
    expect(document.title).toBe('Swarm — Public avatar registry');
  });

  it('shows an avatar as a transparent downloadable project', async () => {
    window.history.replaceState({}, '', '/a/public-ada-1234');
    render(<HostedCatalogApp />);

    expect(await screen.findByRole('heading', { name: 'Public Ada' })).toBeInTheDocument();
    expect(screen.getByText('Think carefully in public.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Studio' })).toHaveAttribute(
      'href',
      '/studio?companion=public-ada-1234',
    );
    expect(screen.getByRole('link', { name: /download portable avatar/i }).getAttribute('href')).toMatch(
      /\/public\/avatars\/public-ada-1234\/bundle$/u,
    );
    expect(document.title).toBe('Public Ada — Swarm');
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
  });

  it('restores the companion list from an empty search', async () => {
    render(<HostedCatalogApp />);
    await screen.findByRole('heading', { name: 'Public Ada' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unknown companion' } });
    expect(screen.queryByRole('heading', { name: 'Public Ada' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all companions' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Public Ada' })).toBeInTheDocument();
  });

  it('keeps long prompts behind a clear disclosure', async () => {
    const project = await hostedApi.getPublicHostedAvatar(summary.slug);
    project.bundle.prompts.system = 'Long public prompt. '.repeat(80);
    vi.mocked(hostedApi.getPublicHostedAvatar).mockResolvedValue(project);
    window.history.replaceState({}, '', '/a/public-ada-1234');
    render(<HostedCatalogApp />);
    const disclosure = await screen.findByText('Read the full prompt');
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(disclosure);
    expect(disclosure.closest('details')).toHaveAttribute('open');
  });
});
