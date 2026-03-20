import { getI18n, ready, t } from './i18n.js';

const app = document.getElementById('app');
const footer = document.getElementById('site-footer');
const i18n = getI18n();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  try {
    const input = String(value ?? '').trim();
    if (!input) return '#';

    const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input) ? input : `https://${input}`;
    const url = new URL(normalized, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en').format(Number(value) || 0);
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || 'en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function truncateAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function extractHandle(url) {
  try {
    const input = String(url ?? '').trim();
    if (!input) return '';

    const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input) ? input : `https://${input}`;
    return new URL(normalized, window.location.origin).pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

function getAvatarId() {
  const { hostname, pathname } = window.location;

  if (hostname.endsWith('.rati.chat')) {
    const subdomain = hostname.replace('.rati.chat', '');
    if (subdomain && subdomain !== 'www') {
      return subdomain;
    }
  }

  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts.length > 0 && pathParts[0] !== 'index.html') {
    return pathParts[0];
  }

  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('avatar');
}

function setMeta(selector, attr, content) {
  const meta = document.querySelector(`meta[${attr}="${selector}"]`);
  if (meta) {
    meta.setAttribute('content', content);
  }
}

function setPageMetadata(title, description) {
  document.title = title;
  setMeta('description', 'name', description);
  setMeta('og:title', 'property', title);
  setMeta('og:description', 'property', description);
  setMeta('twitter:title', 'name', title);
  setMeta('twitter:description', 'name', description);
}

function renderFooter() {
  footer.innerHTML = `${escapeHtml(t('footer.poweredBy'))} <a href="https://rati.chat" rel="noreferrer noopener">${escapeHtml(t('footer.brand'))}</a> &bull; ${escapeHtml(t('footer.verifiable'))}`;
}

function renderLoading() {
  setPageMetadata(t('meta.loadingTitle'), t('meta.loadingDescription'));
  app.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>${escapeHtml(t('status.loadingProfile'))}</p>
    </div>
  `;
}

function renderError(title, message) {
  setPageMetadata(title, message);
  app.innerHTML = `
    <div class="error">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function sectionCard(icon, title, content) {
  return `
    <div class="card">
      <div class="card-header">
        <span>${icon}</span> ${escapeHtml(title)}
      </div>
      ${content}
    </div>
  `;
}

function renderProfileHeader(profile) {
  const twitterHandle = profile.links?.twitter ? extractHandle(profile.links.twitter) : '';

  return `
    <div class="profile-header">
      ${
        profile.profileImage
          ? `<img src="${safeUrl(profile.profileImage)}" alt="${escapeHtml(t('profile.avatarAlt', { name: profile.name }))}" class="avatar">`
          : `<div class="avatar" aria-hidden="true"></div>`
      }
      <div class="profile-info">
        <h1 class="profile-name">${escapeHtml(profile.name)}</h1>
        ${
          profile.links?.twitter
            ? `<p class="profile-handle"><a href="${safeUrl(profile.links.twitter)}" target="_blank" rel="noreferrer noopener">@${escapeHtml(twitterHandle || '')}</a></p>`
            : ''
        }
        <span class="tier-badge tier-${escapeHtml(profile.burnStats.tier)}">
          ${escapeHtml(profile.burnStats.tierEmoji)} ${escapeHtml(t('labels.tierBadge', { tier: profile.burnStats.tier, name: profile.burnStats.tierName }))}
        </span>
      </div>
    </div>
  `;
}

function renderBurnStats(profile) {
  const burnStats = profile.burnStats;
  const sections = [];

  sections.push(`<div class="burn-total"><span>${formatNumber(burnStats.totalBurned)}</span> RATI</div>`);

  if (burnStats.rank) {
    sections.push(`
      <div class="burn-meta">
        <div class="burn-meta-item">
          <span>🏆</span> ${escapeHtml(t('labels.rank', { rank: burnStats.rank, total: burnStats.totalAvatars }))}
        </div>
        <div class="burn-meta-item">
          <span>🔥</span> ${escapeHtml(t('labels.burnCount', { count: burnStats.burnCount }))}
        </div>
      </div>
    `);
  } else {
    sections.push(`
      <div class="burn-meta">
        <div class="burn-meta-item">
          <span>🔥</span> ${escapeHtml(t('labels.burnCount', { count: burnStats.burnCount }))}
        </div>
      </div>
    `);
  }

  if (burnStats.nextTierAt) {
    const remaining = Math.max(0, burnStats.nextTierAt - burnStats.totalBurned);
    sections.push(`
      <div class="progress-container">
        <div class="progress-label">
          <span>${escapeHtml(t('labels.progressTo', { tier: burnStats.nextTierName }))}</span>
          <span>${escapeHtml(String(burnStats.progressPercent ?? 0))}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.max(0, Math.min(100, burnStats.progressPercent ?? 0))}%"></div>
        </div>
        <div class="progress-label">
          <span></span>
          <span>${escapeHtml(t('labels.ratiToGo', { amount: formatNumber(remaining) }))}</span>
        </div>
      </div>
    `);
  } else {
    sections.push(`<p style="color: var(--success); margin-top: 8px;">🎉 ${escapeHtml(t('status.maxTierReached'))}</p>`);
  }

  return sectionCard('🔥', t('sections.burnStats'), sections.join(''));
}

function renderEnergy(profile) {
  const energy = profile.energy;
  const nextRefill = energy.nextRefillIn > 0 ? ` &bull; ${escapeHtml(t('labels.nextRefill', { minutes: energy.nextRefillIn }))}` : '';

  return sectionCard(
    '⚡',
    t('sections.energy'),
    `
      <div class="energy-display">
        <span class="energy-current">${escapeHtml(energy.current)}</span>
        <span class="energy-max">/ ${escapeHtml(energy.max)} ⚡</span>
      </div>
      <p class="energy-regen">
        ${escapeHtml(t('labels.regeneratingAt', { rate: energy.regenPerHour }))}${nextRefill}
      </p>
    `
  );
}

function renderToken(profile) {
  if (!profile.token) return '';

  return sectionCard(
    '🪙',
    t('sections.token'),
    `
      <div class="token-symbol">$${escapeHtml(profile.token.symbol)}</div>
      <div class="token-name">${escapeHtml(profile.token.name)}</div>
      <div class="token-links">
        <a href="${safeUrl(profile.token.launchUrl)}" target="_blank" rel="noreferrer noopener" class="btn btn-primary">
          ${escapeHtml(t('actions.openToken'))}
        </a>
        <a href="${safeUrl(`https://solscan.io/token/${profile.token.mint}`)}" target="_blank" rel="noreferrer noopener" class="btn">
          ${escapeHtml(t('actions.viewOnSolscan'))}
        </a>
      </div>
    `
  );
}

function renderAbout(profile) {
  if (!profile.description) return '';

  return sectionCard(
    '📝',
    t('sections.about'),
    `<p class="about-text">${escapeHtml(profile.description)}</p>`
  );
}

function renderLinks(profile) {
  const links = profile.links || {};
  const items = [];

  if (links.twitter) {
    items.push(`
      <a href="${safeUrl(links.twitter)}" target="_blank" rel="noreferrer noopener" class="social-link">
        <span>𝕏</span> ${escapeHtml(t('social.twitter'))}
      </a>
    `);
  }

  if (links.telegram) {
    items.push(`
      <a href="${safeUrl(links.telegram)}" target="_blank" rel="noreferrer noopener" class="social-link">
        <span>📱</span> ${escapeHtml(t('social.telegram'))}
      </a>
    `);
  }

  if (items.length === 0) return '';

  return sectionCard('🔗', t('sections.links'), `<div class="social-links">${items.join('')}</div>`);
}

function renderWallet(profile) {
  if (!profile.wallet) return '';

  return sectionCard(
    '👛',
    t('sections.wallet'),
    `
      <div class="wallet-address">
        <code>${escapeHtml(profile.wallet.address)}</code>
        <button
          class="copy-btn"
          type="button"
          data-copy-address="${escapeHtml(profile.wallet.address)}"
          title="${escapeHtml(t('actions.copyAddress'))}"
          aria-label="${escapeHtml(t('actions.copyAddress'))}"
        >
          📋
        </button>
        <a href="${safeUrl(profile.wallet.solscanUrl)}" target="_blank" rel="noreferrer noopener" class="copy-btn" title="${escapeHtml(t('actions.viewOnSolscan'))}" aria-label="${escapeHtml(t('actions.viewOnSolscan'))}">
          🔗
        </a>
      </div>
    `
  );
}

function renderBurnHistory(profile) {
  const items = profile.burnHistory || [];
  if (items.length === 0) return '';

  return sectionCard(
    '📜',
    t('sections.burnHistory'),
    `
      <ul class="burn-history">
        ${items
          .map(
            (burn) => `
              <li class="burn-history-item">
                <div>
                  <div class="burn-amount">${escapeHtml(formatNumber(burn.amount))} RATI</div>
                  <div class="burn-date">${escapeHtml(formatDate(burn.timestamp))}</div>
                </div>
                <div class="burn-tx">
                  <a href="${safeUrl(burn.solscanUrl)}" target="_blank" rel="noreferrer noopener">
                    ${escapeHtml(truncateAddress(burn.signature))}
                  </a>
                </div>
              </li>
            `
          )
          .join('')}
      </ul>
    `
  );
}

function bindCopyButtons() {
  app.querySelectorAll('[data-copy-address]').forEach((button) => {
    button.addEventListener('click', async () => {
      const address = button.getAttribute('data-copy-address');
      if (!address) return;

      try {
        await navigator.clipboard.writeText(address);
        button.title = t('actions.copied');
        button.setAttribute('aria-label', t('actions.copied'));
      } catch {
        // Clipboard failures should not break the page.
      }
    });
  });
}

function renderProfile(profile) {
  setPageMetadata(t('meta.profileTitle', { name: profile.name }), t('meta.profileDescription', { name: profile.name }));

  const content = [
    renderProfileHeader(profile),
    renderBurnStats(profile),
    renderEnergy(profile),
    renderToken(profile),
    renderAbout(profile),
    renderLinks(profile),
    renderWallet(profile),
    renderBurnHistory(profile),
  ]
    .filter(Boolean)
    .join('');

  app.innerHTML = content;
  bindCopyButtons();
}

async function fetchProfile(avatarId) {
  const isLocalhost = window.location.hostname.includes('localhost');
  const apiUrl = isLocalhost
    ? `http://localhost:3001/api/profile/${encodeURIComponent(avatarId)}`
    : `https://api.rati.chat/api/profile/${encodeURIComponent(avatarId)}`;

  const response = await fetch(apiUrl);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('not-found');
    }

    throw new Error('load-failed');
  }

  return response.json();
}

async function main() {
  await ready;
  document.documentElement.lang = i18n.resolvedLanguage || i18n.language || 'en';
  renderFooter();
  renderLoading();

  const avatarId = getAvatarId();
  if (!avatarId) {
    renderError(t('meta.notFoundTitle'), t('errors.noAvatarSpecified'));
    return;
  }

  try {
    const profile = await fetchProfile(avatarId);
    renderProfile(profile);
  } catch (error) {
    if (error instanceof Error && error.message === 'not-found') {
      renderError(t('meta.notFoundTitle'), t('errors.avatarNotFound', { avatarId }));
      return;
    }

    if (error instanceof Error && error.message === 'load-failed') {
      renderError(t('meta.errorTitle'), t('errors.failedToLoadProfile'));
      return;
    }

    console.error('Error loading profile:', error);
    renderError(t('meta.errorTitle'), t('errors.failedToConnect'));
  }
}

main();
