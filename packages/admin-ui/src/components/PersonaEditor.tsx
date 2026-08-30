import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getPersona,
  previewPersona,
  updatePersona,
  type PersonaPreviewResponse,
} from '../api/persona';

interface PersonaEditorProps {
  avatarId: string;
  initialPersona?: string;
  onSaved?: (persona: string) => void;
}

export function PersonaEditor({ avatarId, initialPersona = '', onSaved }: PersonaEditorProps) {
  const { t } = useTranslation();
  const [currentPersona, setCurrentPersona] = useState(initialPersona);
  const [draft, setDraft] = useState(initialPersona);
  const [preview, setPreview] = useState<PersonaPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPreview(null);
    setSaved(false);

    getPersona(avatarId)
      .then((result) => {
        if (cancelled) return;
        setCurrentPersona(result.persona);
        setDraft(result.persona);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : t('avatar.personaEditor.loadError'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [avatarId, t]);

  const trimmedDraft = draft.trim();
  const hasChanges = trimmedDraft.length > 0 && trimmedDraft !== currentPersona;
  const changedLineCount = useMemo(
    () => (preview ? preview.diff.added.length + preview.diff.removed.length : 0),
    [preview],
  );

  const handleChange = (value: string) => {
    setDraft(value);
    setPreview(null);
    setError(null);
    setSaved(false);
  };

  const handlePreview = async () => {
    if (!hasChanges) return;
    setIsPreviewing(true);
    setError(null);
    setSaved(false);
    try {
      setPreview(await previewPersona(avatarId, trimmedDraft));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : t('avatar.personaEditor.previewError'));
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSave = async () => {
    if (!preview || !hasChanges) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await updatePersona(avatarId, trimmedDraft);
      setCurrentPersona(result.persona);
      setDraft(result.persona);
      setPreview(null);
      setSaved(true);
      onSaved?.(result.persona);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('avatar.personaEditor.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="py-10 text-center text-sm text-[var(--color-text-muted)]" data-testid="persona-editor-loading">
        {t('avatar.personaEditor.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="persona-editor">
      <div>
        <label htmlFor={`avatarPersona-${avatarId}`} className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
          {t('avatar.systemPersonaLabel')}
        </label>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">
          {t('avatar.personaEditor.description')}
        </p>
        <textarea
          id={`avatarPersona-${avatarId}`}
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          placeholder={t('avatar.systemPersonaPlaceholder')}
          rows={14}
          className="w-full px-4 py-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] placeholder-[var(--color-text-muted)] resize-y focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
          data-testid="avatar-persona-input"
          aria-label={t('avatar.systemPersonaLabel')}
        />
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-900/20 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {saved && (
        <div role="status" className="rounded-lg border border-green-500/40 bg-green-900/20 px-3 py-2 text-sm text-green-300">
          {t('avatar.personaEditor.saved')}
        </div>
      )}

      {preview && (
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-4" data-testid="persona-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">{t('avatar.personaEditor.previewTitle')}</h3>
            <span className="text-xs text-[var(--color-text-muted)]">
              {t('avatar.personaEditor.previewSummary', {
                lines: changedLineCount,
                delta: preview.tokenDelta > 0 ? `+${preview.tokenDelta}` : preview.tokenDelta,
              })}
            </span>
          </div>

          {preview.diff.added.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-green-300">{t('avatar.personaEditor.added')}</div>
              <div className="space-y-1">
                {preview.diff.added.map((line, index) => (
                  <div key={`added-${index}`} className="rounded bg-green-900/20 px-2 py-1 font-mono text-xs text-green-200">+ {line}</div>
                ))}
              </div>
            </div>
          )}

          {preview.diff.removed.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-red-300">{t('avatar.personaEditor.removed')}</div>
              <div className="space-y-1">
                {preview.diff.removed.map((line, index) => (
                  <div key={`removed-${index}`} className="rounded bg-red-900/20 px-2 py-1 font-mono text-xs text-red-200">- {line}</div>
                ))}
              </div>
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)]">
              {t('avatar.personaEditor.systemPrompt')}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-secondary)]">
              {preview.systemPrompt}
            </pre>
          </details>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!hasChanges || isPreviewing || isSaving}
          className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="preview-persona-button"
        >
          {isPreviewing ? t('avatar.personaEditor.previewing') : t('avatar.personaEditor.previewButton')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!preview || !hasChanges || isSaving}
          className="px-5 py-2 rounded-lg bg-brand-600 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="save-persona-button"
        >
          {isSaving ? t('avatar.personaEditor.saving') : t('avatar.personaEditor.saveButton')}
        </button>
      </div>
    </div>
  );
}
