/**
 * Tool Prompt Components - Interactive UI for agent tools
 * These render inline with chat messages when the agent needs user input
 */
import { useState } from 'react';
import type { ToolCall } from '../types';

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
  
  const { secretKey, secretName, description } = toolCall.arguments as {
    secretKey: string;
    secretName?: string;
    description?: string;
  };

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
          {secretName || secretKey} saved securely
        </span>
      </div>
    );
  }

  return (
    <div className="bg-dark-800 border border-dark-600 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-yellow-500/20 rounded-lg">
          <svg className="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-white">
            {secretName || secretKey}
          </h4>
          {description && (
            <p className="text-sm text-dark-300 mt-1">{description}</p>
          )}
          <p className="text-xs text-dark-400 mt-2">
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
          className="flex-1 px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-white placeholder-dark-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          disabled={disabled || isSubmitting}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || disabled || isSubmitting}
          className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-dark-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
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
          : 'bg-dark-700 border border-dark-600'
      }`}>
        <span className={responded === 'confirmed' ? 'text-green-300' : 'text-dark-300'}>
          {responded === 'confirmed' ? '✓ Confirmed' : '✗ Cancelled'}
        </span>
      </div>
    );
  }

  return (
    <div className={`border rounded-lg p-4 space-y-3 ${
      destructive 
        ? 'bg-red-500/10 border-red-500/30' 
        : 'bg-dark-800 border-dark-600'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${destructive ? 'bg-red-500/20' : 'bg-primary-500/20'}`}>
          <svg className={`w-5 h-5 ${destructive ? 'text-red-400' : 'text-primary-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-white">{action}</h4>
          {description && (
            <p className="text-sm text-dark-300 mt-1">{description}</p>
          )}
        </div>
      </div>
      
      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(false)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-4 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => handleResponse(true)}
          disabled={disabled || isSubmitting}
          className={`flex-1 px-4 py-2 rounded-lg transition-colors ${
            destructive
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-primary-600 hover:bg-primary-700'
          } disabled:opacity-50 text-white`}
        >
          {isSubmitting ? 'Processing...' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}

/**
 * Route tool calls to the appropriate prompt component
 */
export function ToolPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  switch (toolCall.name) {
    case 'request_secret':
    case 'prompt_secret':
      return <SecretPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    case 'confirm_action':
      return <ConfirmPrompt toolCall={toolCall} onSubmit={onSubmit} disabled={disabled} />;
    default:
      // Unknown tool - show debug info
      return (
        <div className="bg-dark-800 border border-dark-600 rounded-lg p-4">
          <p className="text-dark-400 text-sm">Unknown tool: {toolCall.name}</p>
          <pre className="mt-2 text-xs text-dark-500 overflow-auto">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </pre>
        </div>
      );
  }
}
