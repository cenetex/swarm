/**
 * Avatar Configuration Modal
 */
import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAvatarStore } from '../store/avatars';
import { useAuth } from '../store/auth';
import type { Avatar, AvatarSecret } from '../types';
import { AvatarDisplay } from './AvatarSidebar';
import { EnergyPanel } from './EnergyPanel';

// Lazy-load UsageMeterPanel — only shown in the config modal's usage tab
const UsageMeterPanel = lazy(() => import('./UsageMeterPanel').then(m => ({ default: m.UsageMeterPanel })));
import * as avatarApi from '../api/avatars';

interface AvatarConfigModalProps {
  avatar: Avatar;
  isOpen: boolean;
  onClose: () => void;
  /**
   * When true, render without the fixed-overlay backdrop / oversized
   * branded header — the panel becomes a content body suitable for
   * embedding inside the workspace Settings tab body (#1638). Defaults to
   * false (legacy modal mode).
   */
  embedded?: boolean;
}

// Predefined secret templates
const SECRET_TEMPLATES: { key: string; nameKey: string; descriptionKey: string }[] = [
  { key: 'REPLICATE_API_KEY', nameKey: 'avatar.secretTemplates.replicate.title', descriptionKey: 'avatar.secretTemplates.replicate.description' },
  { key: 'TELEGRAM_BOT_TOKEN', nameKey: 'avatar.secretTemplates.telegram.title', descriptionKey: 'avatar.secretTemplates.telegram.description' },
  { key: 'OPENROUTER_API_KEY', nameKey: 'avatar.secretTemplates.openrouter.title', descriptionKey: 'avatar.secretTemplates.openrouter.description' },
  { key: 'OPENAI_API_KEY', nameKey: 'avatar.secretTemplates.openai.title', descriptionKey: 'avatar.secretTemplates.openai.description' },
  { key: 'ANTHROPIC_API_KEY', nameKey: 'avatar.secretTemplates.anthropic.title', descriptionKey: 'avatar.secretTemplates.anthropic.description' },
  { key: 'TWITTER_API_KEY', nameKey: 'avatar.secretTemplates.twitter.title', descriptionKey: 'avatar.secretTemplates.twitter.description' },
  { key: 'DISCORD_BOT_TOKEN', nameKey: 'avatar.secretTemplates.discord.title', descriptionKey: 'avatar.secretTemplates.discord.description' },
  { key: 'SOLANA_PRIVATE_KEY', nameKey: 'avatar.secretTemplates.solana.title', descriptionKey: 'avatar.secretTemplates.solana.description' },
];

type SecretTemplate = (typeof SECRET_TEMPLATES)[number];

export function AvatarConfigModal({ avatar, isOpen, onClose, embedded = false }: AvatarConfigModalProps) {
  const { t } = useTranslation();
  const { updateAvatar, deleteAvatar, clearChat } = useAvatarStore();
  const { gateStatus } = useAuth();

  const [name, setName] = useState(avatar.name);
  const [description, setDescription] = useState(avatar.description || '');
  const [persona, setPersona] = useState(avatar.persona || '');
  const [secrets, setSecrets] = useState<AvatarSecret[]>(avatar.secrets || []);
  const [newSecretKey, setNewSecretKey] = useState('');
  const [activeTab, setActiveTab] = useState<'general' | 'persona' | 'secrets'>('general');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  const [selectedOrbMint, setSelectedOrbMint] = useState('');
  const [orbBusy, setOrbBusy] = useState(false);
  const [orbError, setOrbError] = useState<string | null>(null);
  const [saveSucceeded, setSaveSucceeded] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      if (clearChatTimerRef.current) clearTimeout(clearChatTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setName(avatar.name);
    setDescription(avatar.description || '');
    setPersona(avatar.persona || '');
    setSecrets(avatar.secrets || []);
    setSelectedOrbMint('');
    setOrbError(null);
    setConfirmClearChat(false);
    setSaveSucceeded(false);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, [avatar]);

  if (!isOpen) return null;

  const clearSaveFeedback = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveSucceeded(false);
  };

  const markSaveSucceeded = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveSucceeded(true);
    saveTimerRef.current = setTimeout(() => {
      setSaveSucceeded(false);
      saveTimerRef.current = null;
    }, 2500);
  };

  const handleSave = () => {
    updateAvatar(avatar.id, {
      name,
      description,
      persona,
      secrets,
    });
    if (embedded) {
      markSaveSucceeded();
      return;
    }
    onClose();
  };

  const handleAddSecret = (template?: SecretTemplate) => {
    const key = template?.key || newSecretKey.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!key || secrets.some(s => s.key === key)) return;

    clearSaveFeedback();
    setSecrets([
      ...secrets,
      {
        key,
        name: template ? t(template.nameKey) : key,
        description: template ? t(template.descriptionKey) : undefined,
        isSet: false,
      },
    ]);
    setNewSecretKey('');
  };

  const handleRemoveSecret = (key: string) => {
    clearSaveFeedback();
    setSecrets(secrets.filter(s => s.key !== key));
  };

  const handleDelete = () => {
    if (confirmDelete) {
      deleteAvatar(avatar.id);
      onClose();
    } else {
      setConfirmDelete(true);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  const handleClearChat = () => {
    if (confirmClearChat) {
      void clearChat(avatar.id);
      setConfirmClearChat(false);
      return;
    }
    setConfirmClearChat(true);
    if (clearChatTimerRef.current) clearTimeout(clearChatTimerRef.current);
    clearChatTimerRef.current = setTimeout(() => setConfirmClearChat(false), 3000);
  };

  const availableTemplates = SECRET_TEMPLATES.filter(
    t => !secrets.some(s => s.key === t.key)
  );

  const ownedOrbs = gateStatus?.ownedNFTs || [];

  const handleSlotOrb = async () => {
    if (!selectedOrbMint) return;
    setOrbBusy(true);
    setOrbError(null);
    try {
      await avatarApi.slotOrb(avatar.id, selectedOrbMint);
      updateAvatar(avatar.id, {
        orbMint: selectedOrbMint,
        orbSlottedAt: Date.now(),
      });
      setSelectedOrbMint('');
    } catch (e) {
      setOrbError(e instanceof Error ? e.message : t('avatar.errors.slotOrbFailed'));
    } finally {
      setOrbBusy(false);
    }
  };

  const handleUnslotOrb = async () => {
    setOrbBusy(true);
    setOrbError(null);
    try {
      await avatarApi.unslotOrb(avatar.id);
      updateAvatar(avatar.id, {
        orbMint: undefined,
        orbWallet: undefined,
        orbSlottedAt: undefined,
      });
    } catch (e) {
      setOrbError(e instanceof Error ? e.message : t('avatar.errors.unslotOrbFailed'));
    } finally {
      setOrbBusy(false);
    }
  };

  // The modal chrome (fixed-overlay backdrop + oversized header with avatar
  // display and close button) is bypassed when `embedded` is true — the
  // workspace tab body becomes the host. The inner sections (tab strip,
  // tab content, footer) are identical in both modes.
  const containerClass = embedded
    ? 'flex flex-col h-full -mx-4 -my-4'
    : 'relative bg-[var(--color-bg-secondary)] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col border border-[var(--color-border)]';

  const header = embedded ? (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] flex-shrink-0">
      <AvatarDisplay avatar={{ ...avatar, name }} size="md" showStatus={false} />
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={name}
          onChange={(e) => {
            clearSaveFeedback();
            setName(e.target.value);
          }}
          className="text-base font-semibold bg-transparent border-none outline-none text-[var(--color-text)] w-full"
          placeholder={t('avatar.avatarNamePlaceholder')}
          name="avatarName"
          id="avatarName"
          data-testid="avatar-name-input"
          aria-label={t('avatar.avatarNameLabel')}
        />
        <p className="text-xs text-[var(--color-text-tertiary)] truncate">
          {avatar.status === 'shell' ? t('avatar.unconfiguredAvatarShell') : t('avatar.configuredAvatar')}
        </p>
      </div>
    </div>
  ) : (
    <div className="flex items-center gap-4 p-6 border-b border-[var(--color-border)]">
      <AvatarDisplay avatar={{ ...avatar, name }} size="lg" showStatus={false} />
      <div className="flex-1">
        <input
          type="text"
          value={name}
          onChange={(e) => {
            clearSaveFeedback();
            setName(e.target.value);
          }}
          className="text-xl font-semibold bg-transparent border-none outline-none text-[var(--color-text)] w-full"
          placeholder={t('avatar.avatarNamePlaceholder')}
          name="avatarName"
          id="avatarName"
          data-testid="avatar-name-input"
          aria-label={t('avatar.avatarNameLabel')}
        />
        <p className="text-sm text-[var(--color-text-tertiary)]">
          {avatar.status === 'shell' ? t('avatar.unconfiguredAvatarShell') : t('avatar.configuredAvatar')}
        </p>
      </div>
      <button
        onClick={onClose}
        className="p-2 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] transition-colors"
        aria-label={t('avatar.closeModal')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>
    </div>
  );

  const body = (
    <>
      {header}

        {/* Tabs */}
        <div className="flex border-b border-[var(--color-border)]">
          {(['general', 'persona', 'secrets'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'text-brand-400 border-b-2 border-brand-400'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {tab === 'general' ? t('avatar.tabs.general') : tab === 'persona' ? t('avatar.tabs.persona') : t('avatar.tabs.secrets')}
              {tab === 'secrets' && secrets.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 text-xs bg-[var(--color-bg-tertiary)] rounded-full">
                  {secrets.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="avatarDescription" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                  {t('avatar.descriptionLabel')}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => {
                    clearSaveFeedback();
                    setDescription(e.target.value);
                  }}
                  placeholder={t('avatar.descriptionPlaceholder')}
                  rows={3}
                  className="w-full px-4 py-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] placeholder-[var(--color-text-muted)] resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                  name="avatarDescription"
                  id="avatarDescription"
                  data-testid="avatar-description-input"
                  aria-label={t('avatar.descriptionLabel')}
                />
              </div>

              <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--color-text-secondary)]">{t('avatar.orbSlotTitle')}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {t('avatar.orbSlotDescription')}
                    </div>
                  </div>
                  {avatar.orbMint ? (
                    <button
                      onClick={handleUnslotOrb}
                      disabled={orbBusy}
                      className="px-3 py-2 rounded-lg bg-red-900/30 text-red-300 hover:bg-red-900/40 disabled:opacity-50"
                    >
                      {t('avatar.unslotOrb')}
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 text-xs text-[var(--color-text-tertiary)]">
                  {t('avatar.currentOrb')} {avatar.orbMint ? <span className="font-mono">{avatar.orbMint}</span> : t('avatar.none')}
                </div>

                {!avatar.orbMint && ownedOrbs.length > 0 && (
                  <div className="mt-3 flex items-center gap-2">
                    <select
                      value={selectedOrbMint}
                      onChange={(e) => {
                        clearSaveFeedback();
                        setSelectedOrbMint(e.target.value);
                      }}
                      className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)]"
                      disabled={orbBusy}
                    >
                      <option value="">{t('avatar.selectOrbPlaceholder')}</option>
                      {ownedOrbs.map((orb) => (
                        <option key={orb.id} value={orb.id}>
                          {orb.name || orb.id.slice(0, 8)}…
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleSlotOrb}
                      disabled={orbBusy || !selectedOrbMint}
                      className="px-3 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
                    >
                      {t('avatar.slotOrb')}
                    </button>
                  </div>
                )}

                {!avatar.orbMint && ownedOrbs.length === 0 && (
                  <div className="mt-3 text-xs text-[var(--color-text-muted)]">
                    {t('avatar.noOrbsDetected')}
                  </div>
                )}

                {orbError && (
                  <div className="mt-3 text-xs text-red-300">{orbError}</div>
                )}
              </div>

              <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text-secondary)]">
                      {t('avatar.conversationTitle')}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {t('avatar.clearChatDescription')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleClearChat}
                    className={`px-3 py-2 rounded-lg text-sm transition-colors ${
                      confirmClearChat
                        ? 'bg-red-600 text-white hover:bg-red-500'
                        : 'text-red-300 bg-red-900/20 hover:bg-red-900/35'
                    }`}
                  >
                    {confirmClearChat ? t('avatar.clearChatConfirm') : t('chat.panel.clearChat')}
                  </button>
                </div>
              </div>

              {/* Energy Panel */}
              <EnergyPanel avatarId={avatar.id} isAdmin={true} />

              {/* Usage Metering */}
              <Suspense fallback={null}><UsageMeterPanel avatarId={avatar.id} /></Suspense>
            </div>
          )}

          {activeTab === 'persona' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="avatarPersona" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                  {t('avatar.systemPersonaLabel')}
                </label>
                <p className="text-xs text-[var(--color-text-muted)] mb-2">
                  {t('avatar.systemPersonaDescription')}
                </p>
                <textarea
                  value={persona}
                  onChange={(e) => {
                    clearSaveFeedback();
                    setPersona(e.target.value);
                  }}
                  placeholder={t('avatar.systemPersonaPlaceholder')}
                  rows={12}
                  className="w-full px-4 py-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] placeholder-[var(--color-text-muted)] resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
                  name="avatarPersona"
                  id="avatarPersona"
                  data-testid="avatar-persona-input"
                  aria-label={t('avatar.systemPersonaLabel')}
                />
              </div>
            </div>
          )}

          {activeTab === 'secrets' && (
            <div className="space-y-6">
              {/* Current Secrets */}
              {secrets.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-3">
                    {t('avatar.configuredSecretsLabel')}
                  </label>
                  <div className="space-y-2">
                    {secrets.map((secret) => (
                      <div
                        key={secret.key}
                        className="flex items-center gap-3 p-3 bg-[var(--color-bg-tertiary)] rounded-lg"
                      >
                        <div className={`w-2 h-2 rounded-full ${secret.isSet ? 'bg-green-500' : 'bg-[var(--color-text-muted)]'}`} />
                        <div className="flex-1">
                          <div className="font-medium text-[var(--color-text-secondary)]">{secret.name}</div>
                          <div className="text-xs text-[var(--color-text-muted)] font-mono">{secret.key}</div>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded ${secret.isSet ? 'bg-green-900/50 text-green-400' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'}`}>
                          {secret.isSet ? t('avatar.secretState.set') : t('avatar.secretState.notSet')}
                        </span>
                        <button
                          onClick={() => handleRemoveSecret(secret.key)}
                          className="p-1 text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add Secret */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-3">
                  {t('avatar.addSecretLabel')}
                </label>

                {/* Quick Add Templates */}
                {availableTemplates.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs text-[var(--color-text-muted)] mb-2">{t('avatar.quickAdd')}</p>
                    <div className="flex flex-wrap gap-2">
                      {availableTemplates.slice(0, 4).map((template) => (
                        <button
                          key={template.key}
                          onClick={() => handleAddSecret(template)}
                          className="px-3 py-1.5 text-xs bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] rounded-lg transition-colors"
                        >
                          + {t(template.nameKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom Secret */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newSecretKey}
                    onChange={(e) => {
                      clearSaveFeedback();
                      setNewSecretKey(e.target.value);
                    }}
                    placeholder={t('avatar.customSecretPlaceholder')}
                    className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    onKeyDown={(e) => e.key === 'Enter' && handleAddSecret()}
                  />
                  <button
                    onClick={() => handleAddSecret()}
                    disabled={!newSecretKey}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                  >
                    {t('avatar.addSecret')}
                  </button>
                </div>
              </div>

              <p className="text-xs text-[var(--color-text-muted)]">
                {t('avatar.secretsNote')}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-[var(--color-border)]">
          <button
            onClick={handleDelete}
            className={`px-4 py-2 rounded-lg transition-colors ${
              confirmDelete
                ? 'bg-red-600 text-white'
                : 'text-red-400 hover:bg-red-900/50'
            }`}
          >
            {confirmDelete ? t('avatar.deleteAvatarConfirm') : t('avatar.deleteAvatar')}
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              className={`min-w-32 px-6 py-2 text-white rounded-lg font-medium transition-colors ${
                saveSucceeded
                  ? 'bg-green-600 hover:bg-green-500'
                  : 'bg-brand-600 hover:bg-brand-500'
              }`}
              data-testid="save-avatar-button"
              aria-label={saveSucceeded ? t('avatar.savedChanges') : t('avatar.saveChanges')}
            >
              {saveSucceeded ? t('avatar.savedChanges') : t('avatar.saveChanges')}
            </button>
          </div>
        </div>
    </>
  );

  if (embedded) {
    return <div className={containerClass}>{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className={containerClass}>{body}</div>
    </div>
  );
}

// Legacy alias
