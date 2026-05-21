import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolPrompt } from './index';

describe('ToolPrompt', () => {
  it('renders request_model_selection by tool name even when payload type is missing', () => {
    render(
      <ToolPrompt
        toolCall={{
          id: 'call-model',
          name: 'request_model_selection',
          arguments: { capability: 'llm' },
          status: 'pending',
        }}
        onSubmit={vi.fn(async () => ({ ok: true }))}
      />
    );

    expect(screen.getByText('Select LLM Model')).toBeTruthy();
    expect(screen.queryByText(/Unknown tool:/)).toBeNull();
  });
});
