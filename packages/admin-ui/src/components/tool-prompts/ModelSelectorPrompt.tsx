/**
 * Model Selector Prompt - LLM model selection with search & provider grouping
 */
import { useState, useEffect, useMemo } from 'react';
import type { ToolPromptProps } from './types';

const PRIORITY_MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'cohere', 'deepseek'] as const;

export function ModelSelectorPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const args = toolCall.arguments as {
    models: Array<{ id: string; name: string; provider?: string; contextLength?: number; pricing?: { prompt: number; completion: number } }>;
    currentModel?: string;
    instructions?: string;
  };

  const models = args.models || [];
  const currentModel = args.currentModel || '';

  type ProviderModel = (typeof models)[number];

  // Initialize with current model and expand its provider
  useEffect(() => {
    if (currentModel && !selectedModel) {
      setSelectedModel(currentModel);
      const provider = currentModel.split('/')[0];
      if (provider) {
        setExpandedProvider(provider);
      }
    }
  }, [currentModel, selectedModel]);

  // Filter models by search query
  const filteredModels = models.filter((m) =>
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group models by provider with counts
  const groupedModels = useMemo<Record<string, ProviderModel[]>>(() => {
    return filteredModels.reduce<Record<string, ProviderModel[]>>((acc, model) => {
      const provider = model.provider || model.id.split('/')[0] || 'other';
      (acc[provider] ??= []).push(model);
      return acc;
    }, {});
  }, [filteredModels]);

  // Sort providers: prioritize popular ones, then alphabetically
  const sortedProviders = useMemo<string[]>(() => {
    return Object.keys(groupedModels).sort((a, b) => {
      const aIdx = PRIORITY_MODEL_PROVIDERS.indexOf(a as (typeof PRIORITY_MODEL_PROVIDERS)[number]);
      const bIdx = PRIORITY_MODEL_PROVIDERS.indexOf(b as (typeof PRIORITY_MODEL_PROVIDERS)[number]);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [groupedModels]);

  const toggleProvider = (provider: string) => {
    setExpandedProvider(prev => (prev === provider ? null : provider));
  };

  // Keep one provider expanded when search results change
  useEffect(() => {
    if (sortedProviders.length === 0) return;
    if (expandedProvider && sortedProviders.includes(expandedProvider)) return;
    setExpandedProvider(sortedProviders[0]);
  }, [expandedProvider, sortedProviders]);

  const handleSubmit = async () => {
    if (!selectedModel || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(toolCall.id, { selectedModel });
      setSubmitted(true);
    } catch {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    const modelName = models.find(m => m.id === selectedModel)?.name || selectedModel;
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-sm">
        <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-green-300">
          Model changed to: <span className="font-medium">{modelName}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="p-1.5 bg-brand-500/20 rounded-md">
          <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-[var(--color-text)]">Select LLM Model</h4>
          {args.instructions && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{args.instructions}</p>
          )}
          {currentModel && (
            <p className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
              Current: <span className="text-brand-400">{currentModel}</span>
            </p>
          )}
        </div>
      </div>

      {/* Search input */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search models (e.g., claude, gpt-4, llama)..."
          className="w-full pl-9 pr-3 py-1.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
          disabled={disabled || isSubmitting}
        />
      </div>

      {/* Provider count summary */}
      <div className="text-xs text-[var(--color-text-muted)]">
        {filteredModels.length} models from {sortedProviders.length} providers
      </div>

      {/* Model list with collapsible providers */}
      <div className="max-h-72 overflow-y-auto space-y-1">
        {sortedProviders.map((provider) => {
          const providerModels = groupedModels[provider];
          const isExpanded = expandedProvider === provider;
          const hasSelectedModel = providerModels.some(m => m.id === selectedModel);
          
          return (
            <div key={provider} className="border border-[var(--color-border)] rounded-lg overflow-hidden">
              {/* Provider header - clickable to expand/collapse */}
              <button
                onClick={() => toggleProvider(provider)}
                className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                  hasSelectedModel 
                    ? 'bg-brand-600/20 text-brand-400' 
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]'
                }`}
              >
                <span className="font-medium text-sm capitalize">{provider.replace(/-/g, ' ')}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs opacity-70">{providerModels.length} models</span>
                  <svg 
                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
              
              {/* Models list - shown when expanded */}
              {isExpanded && (
                <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] p-1 space-y-1">
                  {providerModels.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => setSelectedModel(model.id)}
                      disabled={disabled || isSubmitting}
                      className={`w-full text-left px-3 py-2 rounded transition-colors text-sm ${
                        selectedModel === model.id
                          ? 'bg-brand-600 text-white'
                          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                      } ${disabled || isSubmitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">{model.name}</span>
                        {model.contextLength && (
                          <span className="text-xs opacity-60 flex-shrink-0">{Math.round(model.contextLength / 1000)}k ctx</span>
                        )}
                      </div>
                      <div className="text-xs opacity-60 truncate">{model.id}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filteredModels.length === 0 && (
          <div className="text-center text-[var(--color-text-tertiary)] py-4">
            No models found matching "{searchQuery}"
          </div>
        )}
      </div>

      {/* Submit button */}
      <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
        <button
          onClick={handleSubmit}
          disabled={!selectedModel || selectedModel === currentModel || disabled || isSubmitting}
          className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm"
        >
          {isSubmitting ? 'Changing...' : 'Change Model'}
        </button>
      </div>
    </div>
  );
}
