/**
 * Chat Panel - Main chat area for active agent
 */
import { useEffect, useRef, useCallback } from 'react';
import { useAgentStore, useActiveAgent, useActiveChat } from '../store/agents';
import { sendChatMessage, saveAgentSecret, pollJobCompletion, updateAgent as updateAgentApi, type JobStatus } from '../api';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AgentAvatar } from './AgentSidebar';

// Track active polling jobs to avoid duplicate polling
const activePollers = new Map<string, { controller: AbortController; agentId: string }>();

interface ChatPanelProps {
  onMenuClick?: () => void;
  onOpenLogs?: (agentId: string) => void;
}

export function ChatPanel({ onMenuClick, onOpenLogs }: ChatPanelProps) {
  const activeAgent = useActiveAgent();
  const messages = useActiveChat();
  const { addMessage, updateMessage, removeMessage, clearChat, updateAgent, isLoading, setLoading, setError } = useAgentStore();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cancel pollers when switching agents or unmounting
  useEffect(() => {
    const currentAgentId = activeAgent?.id;
    return () => {
      if (!currentAgentId) return;
      for (const [jobId, poller] of activePollers) {
        if (poller.agentId === currentAgentId) {
          poller.controller.abort();
          activePollers.delete(jobId);
        }
      }
    };
  }, [activeAgent?.id]);

  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!activeAgent) return;

      // Add user message
      addMessage(activeAgent.id, { role: 'user', content });

      // Add loading message
      addMessage(activeAgent.id, {
        role: 'assistant',
        content: '',
        isLoading: true,
      });

      setLoading(true);
      setError(null);

      try {
        // Build history for API - existing messages only, the server will add the new user message
        // Note: messages is from the closure before we called addMessage, 
        // so it doesn't include the user message we just added
        const history = messages
          .filter((m) => m.id !== 'welcome' && !m.isLoading)
          .map((m) => ({
            role: m.role,
            content: m.content,
          }));

        // Send to API with agent context
        const response = await sendChatMessage(content, history, {
          id: activeAgent.id,
          name: activeAgent.name,
          description: activeAgent.description,
          persona: activeAgent.persona,
        });

        // Update agent avatar if profile image was changed
        if (response.agentUpdates?.profileImageUrl) {
          updateAgent(activeAgent.id, { avatar: response.agentUpdates.profileImageUrl });
        }

        // Update the loading message with the response
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          // Check if there's a pending tool call that needs user input
          const pendingToolCall = response.pendingToolCall;

          // Check for pending jobs from the response (explicit pendingJobs array)
          const pendingJobsList = response.pendingJobs || [];
          
          // Also try to extract job IDs from the response text as fallback
          const responseText = response.response;
          const jobIdMatch = responseText.match(/jobId[:\s]+["']?([a-f0-9-]{36})["']?/i);
          if (jobIdMatch && !pendingJobsList.find(j => j.jobId === jobIdMatch[1])) {
            pendingJobsList.push({ jobId: jobIdMatch[1], type: 'image' });
          }

          // Convert pending jobs to PendingJob format for display
          const pendingJobsForState = pendingJobsList.map(j => ({
            jobId: j.jobId,
            type: (j.type || 'image') as 'image' | 'video' | 'sticker',
            status: 'pending' as const,
            prompt: j.prompt,
            purpose: j.purpose,
          }));

          updateMessage(activeAgent.id, loadingMessage.id, {
            content: response.response,
            isLoading: false,
            // Only add tool calls that need user input (pendingToolCall)
            // Media is displayed via message.media, not as tool calls
            toolCalls: pendingToolCall ? [{
              id: pendingToolCall.id,
              name: pendingToolCall.name,
              arguments: pendingToolCall.arguments,
              status: 'pending' as const,
            }] : undefined,
            // Track pending jobs for status display
            pendingJobs: pendingJobsForState.length > 0 ? pendingJobsForState : undefined,
          });
          
          // Start polling for all pending jobs
          for (const pendingJob of pendingJobsList) {
            const jobId = pendingJob.jobId;
            if (!activePollers.has(jobId)) {
              const messageId = loadingMessage.id;
              const agentIdForPolling = activeAgent.id;
              const controller = new AbortController();
              activePollers.set(jobId, { controller, agentId: agentIdForPolling });

              // Poll in background - don't await
              pollJobCompletion(jobId, {
                intervalMs: 2000,
                maxIntervalMs: 12000,
                signal: controller.signal,
                onProgress: (status: JobStatus) => {
                  const currentMsgs = useAgentStore.getState().chats[agentIdForPolling] || [];
                  const msg = currentMsgs.find(m => m.id === messageId);
                  if (!msg) {
                    const poller = activePollers.get(jobId);
                    poller?.controller.abort();
                    activePollers.delete(jobId);
                    return;
                  }

                  const mediaUrl = status.resultUrl || status.url;
                  const jobPurpose = msg.pendingJobs?.find(j => j.jobId === jobId)?.purpose;
                  
                  // Update pendingJobs status for this job
                  const updatedPendingJobs = (msg.pendingJobs || []).map(j => 
                    j.jobId === jobId 
                      ? { 
                          ...j, 
                          status: status.status as 'pending' | 'processing' | 'completed' | 'failed',
                          prompt: status.prompt,
                          resultUrl: mediaUrl,
                          error: status.error,
                        }
                      : j
                  );

                  if (status.status === 'completed' && mediaUrl) {
                    // Job completed - update status and add to toolCalls for image display
                    const existingToolCalls = msg.toolCalls || [];
                    updateMessage(agentIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                      toolCalls: [
                        ...existingToolCalls,
                        {
                          id: `job-${jobId}`,
                          name: status.type === 'image' ? 'generate_image' : 'generate_video',
                          arguments: { prompt: status.prompt },
                          status: 'completed' as const,
                          result: {
                            url: mediaUrl,
                            prompt: status.prompt,
                            jobId: status.jobId,
                          },
                        },
                      ],
                    });
                    activePollers.delete(jobId);

                    if (jobPurpose === 'profile_image') {
                      void (async () => {
                        try {
                          const updated = await updateAgentApi(agentIdForPolling, {
                            profileImage: {
                              url: mediaUrl,
                              updatedAt: Date.now(),
                            },
                          });
                          updateAgent(agentIdForPolling, {
                            avatar: updated.profileImage?.url || mediaUrl,
                          });
                          addMessage(agentIdForPolling, {
                            role: 'assistant',
                            content: '✅ Profile image updated.',
                          });
                        } catch (err) {
                          console.error('Failed to save profile image:', err);
                        }
                      })();
                    }
                  } else if (status.status === 'failed') {
                    // Job failed - update status
                    updateMessage(agentIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                    });
                    activePollers.delete(jobId);
                  } else {
                    // Job still processing - update status
                    updateMessage(agentIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                    });
                  }
                },
              }).catch((err) => {
                if (err instanceof Error && err.name === 'AbortError') {
                  activePollers.delete(jobId);
                  return;
                }
                console.error('Job polling failed:', err);
                // Update job to failed state on error
                const currentMsgs = useAgentStore.getState().chats[agentIdForPolling] || [];
                const msg = currentMsgs.find(m => m.id === messageId);
                if (msg) {
                  const updatedPendingJobs = (msg.pendingJobs || []).map(j => 
                    j.jobId === jobId 
                      ? { ...j, status: 'failed' as const, error: err.message }
                      : j
                  );
                  updateMessage(agentIdForPolling, messageId, {
                    pendingJobs: updatedPendingJobs,
                  });
                }
                activePollers.delete(jobId);
              });
            }
          }
        }
      } catch (error) {
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          removeMessage(activeAgent.id, loadingMessage.id);
        }

        const errorMsg = error instanceof Error ? error.message : 'Failed to send message';
        setError(errorMsg);
        addMessage(activeAgent.id, {
          role: 'assistant',
          content: `❌ **Error:** ${errorMsg}\n\nPlease try again or check the agent configuration.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [activeAgent, messages, addMessage, updateMessage, removeMessage, setLoading, setError]
  );

  // Handle tool submissions (secrets, confirmations, uploads, etc.)
  const handleToolSubmit = useCallback(
    async (toolCallId: string, result: unknown) => {
      if (!activeAgent) return;

      const resultObj = result as Record<string, unknown>;
      
      // Find the tool call to get its name
      const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
      let toolName: string | undefined;
      for (const msg of currentMessages) {
        const tc = msg.toolCalls?.find(tc => tc.id === toolCallId);
        if (tc) {
          toolName = tc.name;
          break;
        }
      }
      
      // Update the tool call status in the message
      const updateToolCallStatus = () => {
        const msgs = useAgentStore.getState().chats[activeAgent.id] || [];
        for (const msg of msgs) {
          const toolCall = msg.toolCalls?.find(tc => tc.id === toolCallId);
          if (toolCall) {
            updateMessage(activeAgent.id, msg.id, {
              toolCalls: msg.toolCalls?.map(tc => 
                tc.id === toolCallId 
                  ? { ...tc, status: 'completed' as const, result }
                  : tc
              ),
            });
            break;
          }
        }
      };

      // Handle secret submission
      if (resultObj.secretKey && resultObj.value) {
        try {
          await saveAgentSecret(activeAgent.id, resultObj.secretKey as string, resultObj.value as string);
          updateToolCallStatus();
          
          // Send a follow-up message to let the agent know the secret was stored
          const followUpContent = `I've entered my ${(resultObj.secretKey as string).replace(/_/g, ' ')}.`;
          await handleSendMessage(followUpContent);
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save secret';
          setError(errorMsg);
        }
        return;
      }

      // Handle image upload completion
      if (resultObj.success && resultObj.s3Key && resultObj.publicUrl) {
        try {
          updateToolCallStatus();

          const filename = resultObj.filename ? ` (${resultObj.filename})` : '';

          // Check if this is a character reference upload
          const isCharacterReferenceUpload = toolName === 'set_character_reference' ||
                                              toolName === 'get_character_reference_upload_url' ||
                                              resultObj.purpose === 'character_reference';

          // Check if this was a profile image upload (from set_profile_image or get_profile_upload_url)
          const isProfileUpload = !isCharacterReferenceUpload && (
                                   toolName === 'set_profile_image' ||
                                   toolName === 'get_profile_upload_url' ||
                                   !resultObj.category);

          if (isCharacterReferenceUpload) {
            // For character reference, save directly via API
            const { updateAgent: updateAgentApi } = await import('../api/agents');
            await updateAgentApi(activeAgent.id, {
              characterReference: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                description: resultObj.description as string | undefined,
                updatedAt: Date.now(),
              },
            });

            // Add a simple confirmation message
            addMessage(activeAgent.id, {
              role: 'assistant',
              content: '✅ Character reference updated. This will be used for consistent image and video generation.',
            });
          } else if (isProfileUpload) {
            // For profile images, save directly via API - don't rely on LLM
            const { updateAgent: updateAgentApi } = await import('../api/agents');
            await updateAgentApi(activeAgent.id, {
              profileImage: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                updatedAt: Date.now(),
              },
            });

            // Update local state immediately
            updateAgent(activeAgent.id, { avatar: resultObj.publicUrl as string });

            // Add a simple confirmation message instead of asking LLM
            addMessage(activeAgent.id, {
              role: 'assistant',
              content: '✅ Profile image updated.',
            });
          } else {
            // For reference images, ask LLM to save to reference images
            const category = resultObj.category ? ` ${resultObj.category}` : '';
            const followUpContent = `I've uploaded the${category} image${filename}. The s3Key is "${resultObj.s3Key}" and publicUrl is "${resultObj.publicUrl}". Please save it to my reference images.`;
            await handleSendMessage(followUpContent);
          }
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to process upload';
          setError(errorMsg);
        }
        return;
      }

      // Handle confirmation response
      if ('confirmed' in resultObj) {
        updateToolCallStatus();
        const followUpContent = resultObj.confirmed ? 'Yes, proceed.' : 'No, cancel that.';
        await handleSendMessage(followUpContent);
        return;
      }

      // Generic tool result - just update status
      updateToolCallStatus();
    },
    [activeAgent, updateMessage, setError, handleSendMessage, addMessage, updateAgent]
  );

  if (!activeAgent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-bg)] p-4">
        <div className="text-center">
          {/* Mobile menu button */}
          <button
            onClick={onMenuClick}
            className="mb-6 w-12 h-12 mx-auto flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
              <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
            </svg>
          </button>
          <div className="w-20 h-20 lg:w-24 lg:h-24 mx-auto mb-4 lg:mb-6 rounded-full bg-[var(--color-bg-secondary)] ring-4 ring-brand-600 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 lg:w-12 lg:h-12 text-[var(--color-text-muted)]">
              <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
            </svg>
          </div>
          <h3 className="text-lg lg:text-xl font-semibold text-[var(--color-text-secondary)] mb-2">No Agent Selected</h3>
          <p className="text-sm lg:text-base text-[var(--color-text-muted)] mb-4">Create or select an agent to start chatting</p>
          <button
            onClick={() => useAgentStore.getState().createAgent()}
            className="px-4 lg:px-6 py-2.5 lg:py-3 bg-brand-600 hover:bg-brand-500 text-white rounded-xl font-medium transition-colors text-sm lg:text-base"
          >
            Create Your First Agent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
      {/* Agent Header */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 lg:gap-4">
            {/* Hamburger menu - mobile only */}
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            <AgentAvatar agent={activeAgent} size="md" />
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate">{activeAgent.name}</h1>
              <p className="text-xs text-[var(--color-text-tertiary)] truncate hidden sm:block">
                {activeAgent.status === 'shell' && 'Shell agent - configure to unlock full capabilities'}
                {activeAgent.status === 'configured' && `${activeAgent.secrets.filter(s => s.isSet).length} secrets configured`}
                {activeAgent.status === 'active' && 'Active and ready'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => clearChat(activeAgent.id)}
              className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
            >
              <span className="hidden sm:inline">Clear Chat</span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
          {onOpenLogs && (
            <button
              onClick={() => onOpenLogs(activeAgent.id)}
              className="px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] text-xs font-medium transition-colors"
            >
              View logs
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((message) => (
            <ChatMessageComponent 
              key={message.id} 
              message={message} 
              onToolSubmit={handleToolSubmit}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput onSend={handleSendMessage} disabled={isLoading} />
        </div>
      </div>
    </div>
  );
}
