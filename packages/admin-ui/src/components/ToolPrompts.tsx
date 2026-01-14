/**
 * Tool Prompt Components - Interactive UI for agent tools
 * These render inline with chat messages when the agent needs user input
 */
import { useState, useRef, useEffect } from 'react';
import type { ToolCall } from '../types';
import { useActiveAgent } from '../store';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface ToolPromptProps {
  toolCall: ToolCall;
  onSubmit: (toolCallId: string, result: unknown) => void;
  disabled?: boolean;
}

/**
 * Secret Input Prompt - Securely collects API keys and secrets
 * The value is never sent to the LLM, only to the backend for storage
 */
export function SecretPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  
  // Handle both old and new argument structures
  const args = toolCall.arguments as {
    secretKey?: string;
    secretName?: string;
    secretType?: string;
    label?: string;
    description?: string;
    instructions?: string;
  };
  
  const secretKey = args.secretType || args.secretKey || 'secret';
  const secretName = args.label || args.secretName || secretKey;
  const description = args.instructions || args.description;

  const handleSubmit = async () => {
    if (!value.trim() || isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      await onSubmit(toolCall.id, { secretKey, value: value.trim() });
      setSubmitted(true);
      setValue(''); // Clear sensitive data
    } catch {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg">
        <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-green-300">
          {secretName} saved securely
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-yellow-500/20 rounded-lg">
          <svg className="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">
            {secretName}
          </h4>
          {description && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{description}</p>
          )}
          <p className="text-xs text-[var(--color-text-muted)] mt-2">
            🔒 This value is encrypted and never sent to the AI
          </p>
        </div>
      </div>
      
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter secret value..."
          className="flex-1 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          disabled={disabled || isSubmitting}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || disabled || isSubmitting}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {isSubmitting ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Confirmation Prompt - For actions that need user approval
 */
export function ConfirmPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responded, setResponded] = useState<'confirmed' | 'denied' | null>(null);
  
  const { action, description, destructive } = toolCall.arguments as {
    action: string;
    description?: string;
    destructive?: boolean;
  };

  const handleResponse = async (confirmed: boolean) => {
    if (isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      await onSubmit(toolCall.id, { confirmed });
      setResponded(confirmed ? 'confirmed' : 'denied');
    } catch {
      setIsSubmitting(false);
    }
  };

  if (responded) {
    return (
      <div className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
        responded === 'confirmed' 
          ? 'bg-green-500/10 border border-green-500/30' 
          : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
      }`}>
        <span className={responded === 'confirmed' ? 'text-green-300' : 'text-[var(--color-text-secondary)]'}>
          {responded === 'confirmed' ? '✓ Confirmed' : '✗ Cancelled'}
        </span>
      </div>
    );
  }

  return (
    <div className={`border rounded-lg p-4 space-y-3 ${
      destructive 
        ? 'bg-red-500/10 border-red-500/30' 
        : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)]'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${destructive ? 'bg-red-500/20' : 'bg-brand-500/20'}`}>
          <svg className={`w-5 h-5 ${destructive ? 'text-red-400' : 'text-brand-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">{action}</h4>
          {description && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{description}</p>
          )}
        </div>
      </div>
      
      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(false)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => handleResponse(true)}
          disabled={disabled || isSubmitting}
          className={`flex-1 px-4 py-2 rounded-lg transition-colors ${
            destructive
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-brand-600 hover:bg-brand-700'
          } disabled:opacity-50 text-white`}
        >
          {isSubmitting ? 'Processing...' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}

/**
 * Image Upload Prompt - For uploading reference images via signed URL
 */
export function UploadPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const args = toolCall.arguments as {
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
    category?: string;
    purpose?: string;
    description?: string;
    instructions?: string;
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);

    setIsUploading(true);
    setError(null);

    try {
      // Upload to S3 using the signed URL
      const response = await fetch(args.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      // Notify the agent that upload completed
      await onSubmit(toolCall.id, {
        success: true,
        s3Key: args.s3Key,
        publicUrl: args.publicUrl,
        category: args.category,
        purpose: args.purpose,
        description: args.description,
        filename: file.name,
      });

      setUploaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setPreview(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleClick = () => fileInputRef.current?.click();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  if (uploaded) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg">
        {preview && (
          <img src={preview} alt="Uploaded" className="w-12 h-12 rounded object-cover" />
        )}
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-green-300">Image uploaded successfully!</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-brand-500/20 rounded-lg">
          <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">
            Upload {args.purpose === 'character_reference' ? 'Character Reference' : args.category ? `${args.category} ` : ''}Image
          </h4>
          {args.instructions && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{args.instructions}</p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled || isUploading}
      />

      <div
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
          ${dragOver 
            ? 'border-brand-500 bg-brand-500/10' 
            : 'border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)]/50'
          }
          ${(disabled || isUploading) ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[var(--color-text-secondary)]">Uploading...</span>
          </div>
        ) : preview ? (
          <div className="flex flex-col items-center gap-2">
            <img src={preview} alt="Preview" className="max-w-32 max-h-32 rounded object-cover" />
            <span className="text-[var(--color-text-tertiary)] text-sm">Click or drop to replace</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <svg className="w-10 h-10 text-[var(--color-text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-[var(--color-text-secondary)]">Drop an image here or click to browse</span>
            <span className="text-[var(--color-text-muted)] text-sm">PNG, JPG, WebP supported</span>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Model Selector Prompt - Dropdown for selecting LLM models
 */
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

  // Initialize with current model and expand its provider
  useEffect(() => {
    if (currentModel && !selectedModel) {
      setSelectedModel(currentModel);
      const provider = currentModel.split('/')[0];
      if (provider) {
        setExpandedProvider(provider);
      }
    }
  }, [currentModel]);

  // Filter models by search query
  const filteredModels = models.filter(m =>
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group models by provider with counts
  const groupedModels = filteredModels.reduce((acc, model) => {
    const provider = model.provider || model.id.split('/')[0] || 'other';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {} as Record<string, typeof models>);

  // Sort providers: prioritize popular ones, then alphabetically
  const priorityProviders = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'cohere', 'deepseek'];
  const sortedProviders = Object.keys(groupedModels).sort((a, b) => {
    const aIdx = priorityProviders.indexOf(a);
    const bIdx = priorityProviders.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  const toggleProvider = (provider: string) => {
    setExpandedProvider(prev => (prev === provider ? null : provider));
  };

  // Keep one provider expanded when search results change
  useEffect(() => {
    if (sortedProviders.length === 0) return;
    if (expandedProvider && sortedProviders.includes(expandedProvider)) return;
    setExpandedProvider(sortedProviders[0]);
  }, [expandedProvider, sortedProviders.join(',')]);

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
      <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg">
        <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-green-300">
          Model changed to: <span className="font-medium">{modelName}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-brand-500/20 rounded-lg">
          <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">Select LLM Model</h4>
          {args.instructions && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{args.instructions}</p>
          )}
          {currentModel && (
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
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
          className="w-full pl-10 pr-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
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
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm"
        >
          {isSubmitting ? 'Changing...' : 'Change Model'}
        </button>
      </div>
    </div>
  );
}

/**
 * Property Research Authorization Prompt
 * Shows grant/deny buttons for enabling property research
 */
export function PropertyAuthPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responded, setResponded] = useState<'granted' | 'denied' | null>(null);

  const { reason } = toolCall.arguments as {
    reason?: string;
  };

  const handleResponse = async (granted: boolean) => {
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(toolCall.id, { granted });
      setResponded(granted ? 'granted' : 'denied');
    } catch {
      setIsSubmitting(false);
    }
  };

  if (responded) {
    return (
      <div className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
        responded === 'granted'
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
      }`}>
        <span className={responded === 'granted' ? 'text-green-300' : 'text-[var(--color-text-secondary)]'}>
          {responded === 'granted' ? '✓ Property research enabled' : '✗ Property research denied'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-amber-500/20 rounded-lg">
          <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-amber-100">Property Research Authorization</h4>
          {reason && (
            <p className="text-sm text-amber-200/80 mt-1">{reason}</p>
          )}
          <p className="text-xs text-amber-300/60 mt-2">
            This will allow the agent to search for property listings, comparables, and neighborhood data.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(false)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
        >
          Deny
        </button>
        <button
          onClick={() => handleResponse(true)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {isSubmitting ? 'Enabling...' : 'Grant Access'}
        </button>
      </div>
    </div>
  );
}

/**
 * Twitter/X Connection Prompt
 */
export function TwitterConnectPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const activeAgent = useActiveAgent();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [started, setStarted] = useState(false);

  const args = toolCall.arguments as { message?: string };

  const handleConnect = async () => {
    if (!activeAgent?.id || disabled || isSubmitting) return;

    setIsSubmitting(true);
    const url = `${API_BASE}/oauth/twitter/start?agentId=${encodeURIComponent(activeAgent.id)}`;
    window.open(url, '_blank', 'noopener,noreferrer');

    try {
      await onSubmit(toolCall.id, { started: true });
      setStarted(true);
    } catch {
      setIsSubmitting(false);
    }
  };

  if (started) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
        <span className="text-[var(--color-text-secondary)]">
          Twitter connection started. Complete authorization in the new tab.
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-blue-500/20 rounded-lg">
          <svg className="w-5 h-5 text-blue-300" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.95 10.85L20.54 3h-1.56l-5.74 6.84L8.5 3H3.1l6.92 10.09L3.1 21h1.56l5.97-7.11L15.5 21h5.4l-6.95-10.15zm-2.45 2.92l-.7-1.03L5.8 4.5h2.46l4.06 5.98.7 1.02 5.24 7.71h-2.46l-4.3-6.44z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">Connect X/Twitter</h4>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {args.message || 'Authorize this agent to post and manage tweets.'}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-muted)]">
          Opens a new window for OAuth authorization.
        </span>
        <button
          onClick={handleConnect}
          disabled={!activeAgent?.id || disabled || isSubmitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm"
        >
          {isSubmitting ? 'Opening...' : 'Connect X'}
        </button>
      </div>
    </div>
  );
}

/**
 * Feature Toggle Prompt - Toggle switch for enabling/disabling agent features
 */
export function FeatureTogglePrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const args = toolCall.arguments as {
    feature: string;
    currentState: boolean;
    label: string;
    description?: string;
  };

  // Initialize with current state
  useEffect(() => {
    if (enabled === null) {
      setEnabled(args.currentState);
    }
  }, [args.currentState]);

  const handleToggle = async () => {
    if (isSubmitting || enabled === null) return;

    const newState = !enabled;
    setEnabled(newState);
    setIsSubmitting(true);

    try {
      await onSubmit(toolCall.id, { feature: args.feature, enabled: newState });
      setSubmitted(true);
    } catch {
      setEnabled(!newState); // Revert on error
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
        enabled
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
      }`}>
        <span className={enabled ? 'text-green-300' : 'text-[var(--color-text-secondary)]'}>
          {args.label}: {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
    );
  }

  const currentEnabled = enabled ?? args.currentState;

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${currentEnabled ? 'bg-green-500/20' : 'bg-[var(--color-bg-tertiary)]'}`}>
          <svg className={`w-5 h-5 ${currentEnabled ? 'text-green-400' : 'text-[var(--color-text-tertiary)]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">{args.label}</h4>
          {args.description && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{args.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
        <span className="text-sm text-[var(--color-text-secondary)]">
          {currentEnabled ? 'Currently enabled' : 'Currently disabled'}
        </span>
        <button
          onClick={handleToggle}
          disabled={disabled || isSubmitting}
          className={`relative w-14 h-7 rounded-full transition-colors ${
            disabled || isSubmitting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          } ${
            currentEnabled
              ? 'bg-green-600 hover:bg-green-700'
              : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)]'
          }`}
        >
          <span
            className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-sm ${
              currentEnabled ? 'left-8' : 'left-1'
            }`}
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Route tool calls to the appropriate prompt component
 */
export function ToolPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  // Check if this is an upload URL response (from get_profile_upload_url or get_reference_image_upload_url)
  const args = toolCall.arguments as Record<string, unknown>;
  const isUploadUrl = args?.type === 'upload_url' ||
    (args?.uploadUrl && args?.s3Key && args?.publicUrl);

  if (isUploadUrl) {
    return <UploadPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a model selector response
  if (args?.type === 'model_selector') {
    return <ModelSelectorPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a feature toggle response
  if (args?.type === 'feature_toggle') {
    return <FeatureTogglePrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  // Check if this is a Twitter connect response
  if (args?.type === 'twitter_connect') {
    return <TwitterConnectPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
  }

  switch (toolCall.name) {
    case 'request_secret':
    case 'prompt_secret':
      return <SecretPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'confirm_action':
      return <ConfirmPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_property_research':
      return <PropertyAuthPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_feature_toggle':
      return <FeatureTogglePrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'request_twitter_connection':
      return <TwitterConnectPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    default:
      // Unknown tool - show debug info
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4">
          <p className="text-[var(--color-text-tertiary)] text-sm">Unknown tool: {toolCall.name}</p>
          <pre className="mt-2 text-xs text-[var(--color-text-muted)] overflow-auto">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </pre>
        </div>
      );
  }
}
