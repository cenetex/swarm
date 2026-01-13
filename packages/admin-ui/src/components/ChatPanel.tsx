/**
 * Chat Panel - Main chat area for active agent
 * 
 * Access modes:
 * - Admin mode: Full access to chat with tools (inhabited agent or created by user)
 * - Chat mode: Simple chat without admin tools (other agents)
 * - Browse mode: Read-only profile view (no wallet connected)
 */
import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useAgentStore, useActiveAgent, useActiveChat, useWalletAuth } from '../store';
import { sendChatMessage, saveAgentSecret, pollJobCompletion, updateAgent as updateAgentApi, transcribeAudio, type JobStatus } from '../api';
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
  const { user: walletUser, isAuthenticated: isWalletAuthenticated, gateStatus } = useWalletAuth();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Derive hasOrb from gateStatus
  const hasOrb = (gateStatus?.nftsHeld ?? 0) > 0;

  // Determine access mode for this agent
  // - 'browse': Not authenticated - read-only
  // - 'limited': Authenticated but no Orb - can chat with limits
  // - 'chat': Has Orb but not admin - full chat access
  // - 'admin': Inhabiting or created - full admin access
  const accessMode = useMemo(() => {
    if (!isWalletAuthenticated || !walletUser) {
      return 'browse'; // Not authenticated - read-only
    }
    
    const isInhabited = walletUser.inhabitedAgentId === activeAgent?.id;
    const isCreator = activeAgent?.creatorWallet === walletUser.walletAddress;
    
    if (isInhabited || isCreator) {
      return 'admin'; // Full admin access
    }
    
    if (!hasOrb) {
      return 'limited'; // Can chat but with message limits
    }
    
    return 'chat'; // Can chat but no admin tools
  }, [isWalletAuthenticated, walletUser, activeAgent, hasOrb]);

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
      if (accessMode === 'browse') return; // Can't send in browse mode

      // Build sender context from wallet auth
      const sender = isWalletAuthenticated && walletUser ? {
        walletAddress: walletUser.walletAddress,
        displayName: walletUser.displayName,
        avatarUrl: walletUser.avatarUrl,
        inhabitedAgentId: walletUser.inhabitedAgentId,
      } : undefined;

      // Add user message with sender info
      addMessage(activeAgent.id, { role: 'user', content, sender });

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

        // Send to API with agent context and sender info
        const response = await sendChatMessage(content, history, {
          id: activeAgent.id,
          name: activeAgent.name,
          description: activeAgent.description,
          persona: activeAgent.persona,
        }, sender);

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
          
          // DEBUG: Log pendingToolCall to diagnose missing tool prompts
          console.log('[ChatPanel] Response received:', {
            hasContent: !!response.response,
            contentLength: response.response?.length,
            pendingToolCall: pendingToolCall ? { id: pendingToolCall.id, name: pendingToolCall.name } : null,
            pendingJobsCount: response.pendingJobs?.length || 0,
          });

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

  // Handle audio message - transcribe and send as text
  const handleSendAudio = useCallback(
    async (audioBlob: Blob) => {
      if (!activeAgent) return;
      if (accessMode === 'browse') return;

      setLoading(true);
      try {
        // Transcribe the audio
        const result = await transcribeAudio(audioBlob, activeAgent.id);
        if (result.text) {
          // Send the transcribed text as a regular message
          handleSendMessage(`🎤 ${result.text}`);
        }
      } catch (error) {
        console.error('Failed to transcribe audio:', error);
        setError(error instanceof Error ? error.message : 'Failed to transcribe audio');
        setLoading(false);
      }
    },
    [activeAgent, accessMode, handleSendMessage, setLoading, setError]
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

      // Handle model selection updates
      if (typeof resultObj.selectedModel === 'string') {
        try {
          const { getAgent, updateAgent: updateAgentApi } = await import('../api/agents');
          const agent = await getAgent(activeAgent.id);
          const currentConfig = agent.llmConfig || {
            provider: 'openrouter',
            model: resultObj.selectedModel,
            temperature: 0.8,
            maxTokens: 1024,
            useGlobalKey: true,
          };

          await updateAgentApi(activeAgent.id, {
            llmConfig: {
              ...currentConfig,
              model: resultObj.selectedModel,
            },
          });

          updateAgent(activeAgent.id, { model: resultObj.selectedModel });
          updateToolCallStatus();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to update model';
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
                {accessMode === 'admin' && (
                  <span className="text-brand-400">Admin access</span>
                )}
                {accessMode === 'chat' && (
                  <span>Chat mode</span>
                )}
                {accessMode === 'limited' && (
                  <span className="text-amber-400">Limited access • Get an Orb for full access</span>
                )}
                {accessMode === 'browse' && (
                  <span>Connect wallet to chat</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {accessMode === 'admin' && (
              <button
                onClick={() => clearChat(activeAgent.id)}
                className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
              >
                <span className="hidden sm:inline">Clear Chat</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                  <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </div>
          {onOpenLogs && (accessMode === 'admin' || accessMode === 'chat') && (
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

      {/* Input area - varies by access mode */}
      {accessMode === 'browse' ? (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-4">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Connect your wallet to chat with this agent
            </p>
          </div>
        </div>
      ) : accessMode === 'limited' ? (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto space-y-2">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} disabled={isLoading} />
            <div className="flex items-center justify-center gap-2 text-xs text-amber-400">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Limited mode • Get an Orb to unlock full access &amp; inhabit agents</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} disabled={isLoading} />
          </div>
        </div>
      )}
    </div>
  );
}
