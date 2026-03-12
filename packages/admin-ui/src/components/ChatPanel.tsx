/**
 * Chat Panel - Main chat area for active avatar
 * 
 * Access modes:
 * - Admin mode: Full access to chat with tools (created avatar or admin user)
 * - Chat mode: Simple chat without admin tools (other avatars)
 * - Browse mode: Read-only profile view (no wallet connected)
 */
import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useAvatarStore, useActiveAvatar, useActiveChat } from '../store';
import { useTaskCardStore, useTranscriptTimeline } from '../store/task-cards';
import { TaskCard as TaskCardComponent } from './tool-prompts/TaskCard';
import { useAuth } from '../store/auth';
import { sendChatMessage, saveAvatarSecret, submitToolResult, pollJobCompletion, updateAvatar as updateAvatarApi, getAvatar, toggleFeature, transcribeAudio, activateAvatar as apiActivateAvatar, deactivateAvatar as apiDeactivateAvatar, type JobStatus } from '../api';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AvatarDisplay } from './AvatarSidebar';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import { PlanUsagePanel } from './PlanUsagePanel';
import { ActivationChecklist } from './ActivationChecklist';
import { getErrorRecovery } from '../utils/error-recovery';
import { WelcomeMessage } from './WelcomeMessage';
import { UpgradeNudge } from './UpgradeNudge';
import { GalleryPanel } from './GalleryPanel';
import { TaskWorkspace } from './TaskWorkspace';

// Track active polling jobs to avoid duplicate polling
const activePollers = new Map<string, { controller: AbortController; avatarId: string }>();

interface ChatPanelProps {
  onMenuClick?: () => void;
  /** Pre-filled invite code from ?invite= query param */
  initialInviteCode?: string;
}

export function ChatPanel({ onMenuClick, initialInviteCode }: ChatPanelProps) {
  const activeAvatar = useActiveAvatar();
  const messages = useActiveChat();
  const timeline = useTranscriptTimeline(messages, activeAvatar?.id);
  // Extract action functions directly — they're stable references and don't
  // need reactive subscriptions, avoiding full-store re-renders.
  const { addMessage, updateMessage, removeMessage, clearChat, updateAvatar, setLoading, setError, createAvatar } = useAvatarStore.getState();
  const { user: user, isAuthenticated, gateStatus, account } = useAuth();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const [planUsagePanelOpen, setPlanUsagePanelOpen] = useState(!!initialInviteCode);
  const [isCreatingAvatar, setIsCreatingAvatar] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [activationLoading, setActivationLoading] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [galleryPanelOpen, setGalleryPanelOpen] = useState(false);
  // Track which limit types have already shown an upgrade nudge this session
  const shownNudgesRef = useRef(new Set<string>());

  const formatUserFacingError = useCallback((raw: unknown): string => {
    const rawMessage = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : 'Failed to send message';
    const trimmed = rawMessage.trim();

    // If the message contains an appended JSON blob, parse and extract a readable message.
    // Example: "OpenRouter API error: 402 {\"error\":{\"message\":\"...\"}}"
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart !== -1) {
      const prefix = trimmed.slice(0, jsonStart).trim();
      const jsonText = trimmed.slice(jsonStart).trim();
      try {
        const parsed = JSON.parse(jsonText) as { error?: { message?: string; code?: string } | string; message?: string; code?: string };
        const errorObj = typeof parsed?.error === 'object' ? parsed.error : undefined;
        const extractedMessage: string | undefined =
          errorObj?.message ||
          parsed?.message ||
          (typeof parsed?.error === 'string' ? parsed.error : undefined);

        const code = parsed?.code || errorObj?.code;
        const pieces = [prefix];
        if (code && !String(prefix).includes(String(code))) pieces.push(String(code));
        if (extractedMessage) pieces.push(extractedMessage);

        const cleaned = pieces
          .filter(Boolean)
          .join(' - ')
          .replace(/\s+-\s+-\s+/g, ' - ')
          .trim();

        return cleaned || prefix || 'Request failed';
      } catch {
        // If parsing fails, fall through to basic cleanup.
      }
    }

    // Avoid leaking structured metadata that occasionally appears inline.
    // (We still keep the human-readable portion.)
    return trimmed
      .replace(/\buser_id\b\s*[:=]\s*["']?user_[A-Za-z0-9]+["']?/g, 'user_id:[redacted]')
      .replace(/\s+metadata:\s*\{[\s\S]*\}\s*$/i, '')
      .trim();
  }, []);

  const extractPendingJobsFromText = useCallback((text: string): Array<{ jobId: string; type: 'image' | 'video' | 'sticker' }> => {
    const found: Array<{ jobId: string; type: 'image' | 'video' | 'sticker' }> = [];
    if (!text) return found;

    // MCP server convention
    // Example: [Pending Job: image] ID: 123e4567-e89b-12d3-a456-426614174000
    for (const match of text.matchAll(/\[Pending Job:\s*(image|video|sticker)\]\s*ID:\s*([a-f0-9-]{36})/gi)) {
      const type = (match[1] || 'image').toLowerCase() as 'image' | 'video' | 'sticker';
      const jobId = match[2];
      if (jobId) found.push({ jobId, type });
    }

    // Generic patterns commonly surfaced in tool text
    for (const match of text.matchAll(/\bjobId\b\s*[:=]\s*["']?([a-f0-9-]{36})["']?/gi)) {
      const jobId = match[1];
      if (jobId) found.push({ jobId, type: 'image' });
    }
    for (const match of text.matchAll(/\bJob ID\b\s*[:=]\s*([a-f0-9-]{36})/gi)) {
      const jobId = match[1];
      if (jobId) found.push({ jobId, type: 'image' });
    }

    // Deduplicate by jobId
    const deduped = new Map<string, { jobId: string; type: 'image' | 'video' | 'sticker' }>();
    for (const j of found) {
      if (!deduped.has(j.jobId)) deduped.set(j.jobId, j);
    }
    return Array.from(deduped.values());
  }, []);

  // Derive hasOrb from gateStatus
  const hasOrb = (gateStatus?.nftsHeld ?? 0) > 0;

  // Public bot subdomains render their own header; avoid double-stacking headers.
  const shouldRenderHeader = useMemo(() => {
    if (typeof window === 'undefined') return true;
    const normalizedRaw = window.location.hostname?.toLowerCase() || '';
    const normalized = normalizedRaw.replace(/\.$/, '');
    if (!normalized.endsWith('.rati.chat')) return true;

    const reserved = new Set([
      'swarm',
      'staging-swarm',
      'www',
      'admin',
      'api',
      'cdn',
      'gallery',
      'docs',
    ]);

    const [subdomain] = normalized.split('.');
    const isBotSubdomain = Boolean(
      subdomain &&
        !reserved.has(subdomain) &&
        !subdomain.startsWith('admin-') &&
        !subdomain.startsWith('api-')
    );

    return !isBotSubdomain;
  }, []);

  // Determine access mode for this avatar
  // - 'browse': Not authenticated - read-only
  // - 'limited': Authenticated but no Orb - can chat with limits
  // - 'chat': Has Orb but not admin - full chat access
  // - 'admin': Created avatar or admin user - full admin access
  const accessMode = useMemo(() => {
    if (!isAuthenticated || !user) {
      return 'browse'; // Not authenticated - read-only
    }
    
    const isAdminUser = account?.role === 'admin';
    const isCreator = activeAvatar?.creatorWallet === user.walletAddress;
    
    if (isAdminUser || isCreator) {
      return 'admin'; // Full admin access
    }
    
    if (!hasOrb) {
      return 'limited'; // Can chat but with message limits
    }
    
    return 'chat'; // Can chat but no admin tools
  }, [isAuthenticated, user, activeAvatar, hasOrb, account?.role]);

  // Activation toggle handler
  const handleActivationToggle = useCallback(async () => {
    if (!activeAvatar || activationLoading) return;

    const isCurrentlyActive = activeAvatar.status === 'active';

    // If deactivating, require confirmation first
    if (isCurrentlyActive && !showDeactivateConfirm) {
      setShowDeactivateConfirm(true);
      return;
    }

    setActivationLoading(true);
    setActivationError(null);
    setShowDeactivateConfirm(false);

    try {
      if (isCurrentlyActive) {
        await apiDeactivateAvatar(activeAvatar.id);
        updateAvatar(activeAvatar.id, { status: 'paused' });
      } else {
        await apiActivateAvatar(activeAvatar.id);
        updateAvatar(activeAvatar.id, { status: 'active' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update avatar status';
      setActivationError(message);
      // Auto-clear error after 5 seconds
      setTimeout(() => setActivationError(null), 5000);
    } finally {
      setActivationLoading(false);
    }
  }, [activeAvatar, activationLoading, showDeactivateConfirm, updateAvatar]);

  // Cancel deactivation confirmation
  const handleCancelDeactivate = useCallback(() => {
    setShowDeactivateConfirm(false);
  }, []);

  // Determine if platforms are configured but avatar is not active (warning state)
  const hasConfiguredPlatformsButInactive = useMemo(() => {
    if (!activeAvatar) return false;
    if (activeAvatar.status === 'active') return false;
    const p = activeAvatar.platforms;
    return Boolean(
      p?.telegram?.enabled ||
      p?.twitter?.enabled ||
      p?.discord?.enabled
    );
  }, [activeAvatar]);

  // Auto-scroll to bottom — depend on length, not reference, to avoid
  // scroll-jacking when polling updates mutate the messages array.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Cancel pollers when switching avatars or unmounting
  useEffect(() => {
    const currentAvatarId = activeAvatar?.id;
    return () => {
      if (!currentAvatarId) return;
      for (const [jobId, poller] of activePollers) {
        if (poller.avatarId === currentAvatarId) {
          poller.controller.abort();
          activePollers.delete(jobId);
        }
      }
    };
  }, [activeAvatar?.id]);

  // Handle sending a message - creates avatar first if needed
  const handleSendMessage = useCallback(
    async (content: string) => {
      // Hide the hint when user starts chatting
      setShowHint(false);
      
      // If no avatar exists, create one first
      let targetAvatar = activeAvatar;
      if (!targetAvatar) {
        if (isCreatingAvatar) return; // Already creating
        setIsCreatingAvatar(true);
        try {
          targetAvatar = await createAvatar();
        } catch (err) {
          console.error('Failed to create avatar:', err);
          setError('Failed to create avatar');
          setIsCreatingAvatar(false);
          return;
        }
        setIsCreatingAvatar(false);
        if (!targetAvatar) return;
      }
      
      if (accessMode === 'browse') return; // Can't send in browse mode

      // Build sender context from wallet auth
      const sender = isAuthenticated && user ? {
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      } : undefined;

      // Add user message with sender info
      addMessage(targetAvatar.id, { role: 'user', content, sender });

      // Add loading message
      addMessage(targetAvatar.id, {
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
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.serverToolCalls ? { tool_calls: m.serverToolCalls } : {}),
          }));

        // Send to API with avatar context and sender info
        const response = await sendChatMessage(content, history, {
          id: targetAvatar.id,
          name: targetAvatar.name,
          description: targetAvatar.description,
          persona: targetAvatar.persona,
        }, sender);

        // Update avatar avatar if profile image was changed
        if (response.avatarUpdates?.profileImageUrl) {
          updateAvatar(targetAvatar.id, { avatar: response.avatarUpdates.profileImageUrl });
        }
        
        // Update avatar name if it was changed
        if (response.avatarUpdates?.name) {
          updateAvatar(targetAvatar.id, { name: response.avatarUpdates.name });
        }

        // Update the loading message with the response
        const currentMessages = useAvatarStore.getState().chats[targetAvatar.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          // Check if there's a pending tool call that needs user input
          const pendingToolCall = response.pendingToolCall;
          
          // Pending jobs can arrive either as structured `pendingJobs` OR embedded in tool-result text.
          const pendingJobsList = [...(response.pendingJobs || [])];
          
          // Filter out stale "Please connect your X/Twitter account:" text from responses
          // This text can appear when the model repeats from chat history after a connection attempt
          const responseText = response.response.replace(
            /please\s+connect\s+your\s+(x\/?twitter|twitter\/?x)\s+account\s*:/gi,
            ''
          ).trim();
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

          // Pull tool-result messages (role=tool) from the backend response history
          // so rich cards (Twitter Connected / Tweet Posted) show immediately.
          const historyFromServer = Array.isArray(response.history) ? response.history : [];
          const assistantFromServer = (() => {
            for (let i = historyFromServer.length - 1; i >= 0; i--) {
              const msg = historyFromServer[i] as { role?: unknown; content?: unknown };
              if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0) {
                return historyFromServer[i] as { thinking?: string[] };
              }
            }
            return undefined;
          })();
          const thinkingFromServer = Array.isArray(assistantFromServer?.thinking) ? assistantFromServer?.thinking : undefined;
          const lastUserIndex = (() => {
            for (let i = historyFromServer.length - 1; i >= 0; i--) {
              const msg = historyFromServer[i];
              if (msg && msg.role === 'user' && msg.content === content) return i;
            }
            return -1;
          })();
          const toolResultEntries: Array<{ content: string; tool_call_id: string }> = [];
          // Also find the assistant message with tool_calls (the one right before tool results)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let assistantToolCallsMsg: any = null;
          if (lastUserIndex >= 0) {
            for (const msg of historyFromServer.slice(lastUserIndex + 1)) {
              if (msg && msg.role === 'tool' && typeof msg.content === 'string') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tcId = (msg as any).tool_call_id;
                if (tcId && typeof tcId === 'string') {
                  toolResultEntries.push({ content: msg.content, tool_call_id: tcId });
                }
              }
              if (msg && msg.role === 'assistant' && Array.isArray((msg as Record<string, unknown>).tool_calls)) {
                assistantToolCallsMsg = msg;
              }
            }
          }

          // Extract job ids from tool-result messages (these often contain the only jobId)
          for (const entry of toolResultEntries) {
            for (const j of extractPendingJobsFromText(entry.content)) {
              if (!pendingJobsList.find(existing => existing.jobId === j.jobId)) {
                pendingJobsList.push({ jobId: j.jobId, type: j.type });
              }
            }
          }

          // Replace the loading message in-place (preserve messageId for job polling),
          // and splice tool-result messages right before it.
          // Also insert a hidden assistant message with tool_calls for history accuracy.
          const current = useAvatarStore.getState().chats[targetAvatar.id] || [];
          const loadingIndex = current.findIndex(m => m.id === loadingMessage.id);

          // Build the hidden assistant-with-tool_calls message (needed for valid history)
          const toolCallAssistantMessages = assistantToolCallsMsg ? [{
            id: (globalThis.crypto && 'randomUUID' in globalThis.crypto)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? (globalThis.crypto as any).randomUUID()
              : `tc-ast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'assistant' as const,
            content: '',
            timestamp: Date.now(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            serverToolCalls: (assistantToolCallsMsg as any).tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
          }] : [];

          const toolMessages = toolResultEntries.map((entry) => ({
            id: (globalThis.crypto && 'randomUUID' in globalThis.crypto)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? (globalThis.crypto as any).randomUUID()
              : `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'tool' as const,
            content: entry.content,
            tool_call_id: entry.tool_call_id,
            timestamp: Date.now(),
            isToolResult: true,
          }));

          const updatedLoading = {
            ...loadingMessage,
            content: responseText,
            isLoading: false,
            thinking: thinkingFromServer,
            toolCalls: pendingToolCall
              ? [{
                  id: pendingToolCall.id,
                  name: pendingToolCall.name,
                  arguments: pendingToolCall.arguments,
                  status: 'pending' as const,
                }]
              : undefined,
            pendingJobs: pendingJobsForState.length > 0 ? pendingJobsForState : undefined,
            media: response.media,
          };

          // Register in task card store so it survives setChat() replacements
          if (pendingToolCall) {
            useTaskCardStore.getState().registerTaskCard({
              id: pendingToolCall.id,
              avatarId: targetAvatar.id,
              toolName: pendingToolCall.name,
              arguments: pendingToolCall.arguments,
            });
          }

          if (loadingIndex >= 0) {
            const next = [
              ...current.slice(0, loadingIndex),
              ...toolCallAssistantMessages,
              ...toolMessages,
              updatedLoading,
              ...current.slice(loadingIndex + 1),
            ];
            useAvatarStore.getState().setChat(targetAvatar.id, next);
          } else {
            // Fallback: if loading message vanished, just append.
            for (const tcm of toolCallAssistantMessages) {
              addMessage(targetAvatar.id, {
                role: tcm.role,
                content: tcm.content,
                serverToolCalls: tcm.serverToolCalls,
              });
            }
            for (const tm of toolMessages) {
              addMessage(targetAvatar.id, {
                role: tm.role,
                content: tm.content,
                tool_call_id: tm.tool_call_id,
                isToolResult: true,
              });
            }
            addMessage(targetAvatar.id, {
              role: 'assistant',
              content: updatedLoading.content,
              toolCalls: updatedLoading.toolCalls,
              pendingJobs: updatedLoading.pendingJobs,
              media: updatedLoading.media,
            });
          }
          
          // Start polling for all pending jobs
          for (const pendingJob of pendingJobsList) {
            const jobId = pendingJob.jobId;
            if (!activePollers.has(jobId)) {
              const messageId = loadingMessage.id;
              const avatarIdForPolling = targetAvatar.id;
              const controller = new AbortController();
              activePollers.set(jobId, { controller, avatarId: avatarIdForPolling });

              // Poll in background - don't await
              pollJobCompletion(jobId, {
                intervalMs: 2000,
                maxIntervalMs: 12000,
                signal: controller.signal,
                onProgress: (status: JobStatus) => {
                  const currentMsgs = useAvatarStore.getState().chats[avatarIdForPolling] || [];
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
                    updateMessage(avatarIdForPolling, messageId, {
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
                          const updated = await updateAvatarApi(avatarIdForPolling, {
                            profileImage: {
                              url: mediaUrl,
                              updatedAt: Date.now(),
                            },
                          });
                          updateAvatar(avatarIdForPolling, {
                            avatar: updated.profileImage?.url || mediaUrl,
                          });
                          addMessage(avatarIdForPolling, {
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
                    updateMessage(avatarIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                    });
                    activePollers.delete(jobId);
                  } else {
                    // Job still processing - update status
                    updateMessage(avatarIdForPolling, messageId, {
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
                const currentMsgs = useAvatarStore.getState().chats[avatarIdForPolling] || [];
                const msg = currentMsgs.find(m => m.id === messageId);
                if (msg) {
                  const updatedPendingJobs = (msg.pendingJobs || []).map(j => 
                    j.jobId === jobId 
                      ? { ...j, status: 'failed' as const, error: err.message }
                      : j
                  );
                  updateMessage(avatarIdForPolling, messageId, {
                    pendingJobs: updatedPendingJobs,
                  });
                }
                activePollers.delete(jobId);
              });
            }
          }
        }
      } catch (error) {
        const currentMessages = useAvatarStore.getState().chats[targetAvatar.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          removeMessage(targetAvatar.id, loadingMessage.id);
        }

        const errorMsg = formatUserFacingError(error);
        setError(errorMsg);

        // Extract structured limit info if present (from 429 limit errors)
        const errorLimitInfo = (error as Error & { limitInfo?: { limitType: string; current: number; limit: number; remaining: number } }).limitInfo;

        // Build rich error message with recovery guidance
        const recovery = getErrorRecovery(errorMsg);
        let errorContent: string;
        if (recovery) {
          const actionList = recovery.actions.map(a => `- ${a}`).join('\n');
          errorContent = `**${recovery.title}**\n\n${recovery.explanation}\n\n**What to do:**\n${actionList}`;
        } else {
          errorContent = `**Error:** ${errorMsg}\n\nPlease try again or check the avatar configuration.`;
        }

        addMessage(targetAvatar.id, {
          role: 'assistant',
          content: errorContent,
          // Attach limit info so ChatMessage can render the upgrade nudge
          ...(errorLimitInfo ? { limitInfo: errorLimitInfo } : {}),
        });
      } finally {
        setLoading(false);
      }
    },
    [activeAvatar, messages, addMessage, updateMessage, removeMessage, setLoading, setError, createAvatar, isCreatingAvatar, accessMode, isAuthenticated, user, updateAvatar, formatUserFacingError, extractPendingJobsFromText]
  );

  // Handle audio message - transcribe and send as text
  const handleSendAudio = useCallback(
    async (audioBlob: Blob) => {
      // Audio requires an existing avatar for now
      if (!activeAvatar) {
        // Create avatar first, then handle audio
        const newAvatar = await createAvatar();
        if (!newAvatar) return;
      }
      if (accessMode === 'browse') return;

      const targetAvatar = activeAvatar || useAvatarStore.getState().avatars.find(a => a.id === useAvatarStore.getState().activeAvatarId);
      if (!targetAvatar) return;

      setLoading(true);
      try {
        // Transcribe the audio
        const result = await transcribeAudio(audioBlob, targetAvatar.id);
        if (result.text) {
          // Send the transcribed text as a regular message
          handleSendMessage(`🎤 ${result.text}`);
        }
      } catch (error) {
        console.error('Failed to transcribe audio:', error instanceof Error ? error.message : String(error));
        setError(error instanceof Error ? error.message : 'Failed to transcribe audio');
        setLoading(false);
      }
    },
      [activeAvatar, accessMode, createAvatar, handleSendMessage, setLoading, setError]
  );

  // Handle tool submissions (secrets, confirmations, uploads, etc.)
  const handleToolSubmit = useCallback(
    async (toolCallId: string, result: unknown) => {
      if (!activeAvatar) return;

      const resultObj = result as Record<string, unknown>;
      
      // Find the tool call to get its name
      const currentMessages = useAvatarStore.getState().chats[activeAvatar.id] || [];
      let toolName: string | undefined;
      for (const msg of currentMessages) {
        const tc = msg.toolCalls?.find(tc => tc.id === toolCallId);
        if (tc) {
          toolName = tc.name;
          break;
        }
      }
      
      // Register a resumed pendingToolCall into the task card store
      const registerResumedToolCall = (
        pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> },
      ) => {
        useTaskCardStore.getState().registerTaskCard({
          id: pendingToolCall.id,
          avatarId: activeAvatar.id,
          toolName: pendingToolCall.name,
          arguments: pendingToolCall.arguments,
        });
      };

      // Detect if this submission is a cancellation
      const isCancelled = resultObj.cancelled === true ||
        (resultObj.confirmed === false) ||
        (resultObj.linked === false && resultObj.cancelled === true);

      // Update the tool call status in both the message and the task card store.
      // The task card store supports richer statuses (cancelled/dismissed) while
      // the ToolCall type on messages only supports pending/completed/failed.
      const updateToolCallStatus = (status: 'completed' | 'failed' = 'completed') => {
        // Map to the richer task card status
        const cardStatus = (status === 'completed' && isCancelled) ? 'cancelled' as const : status;
        useTaskCardStore.getState().updateStatus(toolCallId, cardStatus, result);
        const msgs = useAvatarStore.getState().chats[activeAvatar.id] || [];
        for (const msg of msgs) {
          const toolCall = msg.toolCalls?.find(tc => tc.id === toolCallId);
          if (toolCall) {
            updateMessage(activeAvatar.id, msg.id, {
              toolCalls: msg.toolCalls?.map(tc =>
                tc.id === toolCallId
                  ? { ...tc, status, result }
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
          await saveAvatarSecret(activeAvatar.id, resultObj.secretKey as string, resultObj.value as string);

          const resumed = await submitToolResult(activeAvatar.id, toolCallId, {
            stored: true,
            secretKey: resultObj.secretKey,
          });

          updateToolCallStatus();

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });
          if (resumed.pendingToolCall) {
            registerResumedToolCall(resumed.pendingToolCall);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save secret';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Handle image upload completion
      if (resultObj.success && resultObj.s3Key && resultObj.publicUrl) {
        try {
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
            await updateAvatarApi(activeAvatar.id, {
              characterReference: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                description: resultObj.description as string | undefined,
                updatedAt: Date.now(),
              },
            });

            // Add a simple confirmation message
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '✅ Character reference updated. This will be used for consistent image and video generation.',
            });
          } else if (isProfileUpload) {
            // For profile images, save directly via API - don't rely on LLM
            await updateAvatarApi(activeAvatar.id, {
              profileImage: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                updatedAt: Date.now(),
              },
            });

            // Update local state immediately
            updateAvatar(activeAvatar.id, { avatar: resultObj.publicUrl as string });

            // Add a simple confirmation message instead of asking LLM
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '✅ Profile image updated.',
            });
          } else {
            // For reference images, resume the tool loop with a tool result (no synthetic user message)
            const resumed = await submitToolResult(activeAvatar.id, toolCallId, {
              success: true,
              s3Key: resultObj.s3Key,
              publicUrl: resultObj.publicUrl,
              filename: resultObj.filename,
              category: resultObj.category,
              purpose: resultObj.purpose,
              description: resultObj.description,
            });

            if (resumed.avatarUpdates?.profileImageUrl) {
              updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
            }
            if (resumed.avatarUpdates?.name) {
              updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
            }

            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: resumed.response,
              toolCalls: resumed.pendingToolCall ? [{
                id: resumed.pendingToolCall.id,
                name: resumed.pendingToolCall.name,
                arguments: resumed.pendingToolCall.arguments,
                status: 'pending',
              }] : undefined,
              media: resumed.media,
            });
            if (resumed.pendingToolCall) {
              registerResumedToolCall(resumed.pendingToolCall);
            }
          }

          // Mark complete only after the async branch succeeded
          updateToolCallStatus();

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to process upload';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Handle model selection updates
      if (typeof resultObj.selectedModel === 'string') {
        try {
          const avatar = await getAvatar(activeAvatar.id);
          const currentConfig = avatar.llmConfig || {
            provider: 'openrouter',
            model: resultObj.selectedModel,
            temperature: 0.8,
            maxTokens: 1024,
            useGlobalKey: true,
          };

          await updateAvatarApi(activeAvatar.id, {
            llmConfig: {
              ...currentConfig,
              model: resultObj.selectedModel,
            },
          });

          updateAvatar(activeAvatar.id, { model: resultObj.selectedModel });
          updateToolCallStatus();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to update model';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Handle feature toggle updates
      if (typeof resultObj.feature === 'string' && typeof resultObj.enabled === 'boolean') {
        try {
          await toggleFeature(
            activeAvatar.id,
            resultObj.feature as 'media' | 'voice' | 'twitter' | 'telegram' | 'discord',
            resultObj.enabled
          );
          updateToolCallStatus();

          // Fallback UX: if Twitter was enabled but model didn't prompt for connect
          if (resultObj.feature === 'twitter' && resultObj.enabled) {
            const existing = useAvatarStore.getState().chats[activeAvatar.id] || [];
            const hasPendingConnect = existing.some((m) =>
              m.toolCalls?.some((tc) => tc.name === 'request_twitter_connection' && tc.status === 'pending')
            );
            if (hasPendingConnect) return;

            const twitterToolCallId = crypto.randomUUID();
            const twitterArgs = {
              type: 'twitter_connect' as const,
              message: 'Authorize this avatar to post and manage tweets.',
            };
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '', // TwitterConnectPrompt renders its own UI
              toolCalls: [{
                id: twitterToolCallId,
                name: 'request_twitter_connection',
                arguments: twitterArgs,
                status: 'pending',
              }],
            });
            registerResumedToolCall(
              { id: twitterToolCallId, name: 'request_twitter_connection', arguments: twitterArgs },
            );
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to toggle feature';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Handle confirmation response
      if ('confirmed' in resultObj) {
        try {
          const resumed = await submitToolResult(activeAvatar.id, toolCallId, resultObj);
          updateToolCallStatus();

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });
          if (resumed.pendingToolCall) {
            registerResumedToolCall(resumed.pendingToolCall);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to submit tool result';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Handle configure_integration results — persist config to backend
      if (resultObj.configured === true && typeof resultObj.integration === 'string') {
        try {
          const resumed = await submitToolResult(activeAvatar.id, toolCallId, resultObj);
          updateToolCallStatus();

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });
          if (resumed.pendingToolCall) {
            registerResumedToolCall(resumed.pendingToolCall);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save integration config';
          result = { ...(result as Record<string, unknown>), error: errorMsg };
          updateToolCallStatus('failed');
          setError(errorMsg);
        }
        return;
      }

      // Generic tool result - just update status
      updateToolCallStatus();
    },
    [activeAvatar, updateMessage, setError, addMessage, updateAvatar]
  );

  if (!activeAvatar) {
    // Show chat interface ready to create avatar on first message
    return (
      <div className="flex-1 flex flex-col h-full min-w-0 bg-[var(--color-bg)]">
        {/* Minimal header with menu button */}
        <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
          <div className="flex items-center gap-3 lg:gap-4">
            {onMenuClick && (
              <button
                onClick={onMenuClick}
                className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
                aria-label="Open menu"
                data-testid="menu-button"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 lg:w-6 lg:h-6 text-white">
                <path d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 9a.75.75 0 00-1.5 0v2.25H9a.75.75 0 000 1.5h2.25V15a.75.75 0 001.5 0v-2.25H15a.75.75 0 000-1.5h-2.25V9z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)]">New Avatar</h1>
              <p className="text-xs text-[var(--color-text-tertiary)]">Start chatting to create</p>
            </div>
          </div>
        </header>

        {/* Empty chat area with hint */}
        <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4 flex items-center justify-center">
          <div 
            className={`text-center transition-opacity duration-500 ${showHint ? 'opacity-100' : 'opacity-0'}`}
          >
            <div className="w-20 h-20 lg:w-24 lg:h-24 mx-auto mb-4 lg:mb-6 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-700/20 ring-2 ring-brand-600/30 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 lg:w-12 lg:h-12 text-brand-500">
                <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-lg lg:text-xl font-medium text-[var(--color-text-secondary)] mb-2">
              Chat to create your first avatar
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              Just say hello and we'll get started
            </p>
          </div>
        </div>

        {/* Input area */}
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              onSend={handleSendMessage}
              onSendAudio={handleSendAudio}
              disabled={isCreatingAvatar}
              placeholder={isCreatingAvatar ? "Creating your avatar..." : "Say hello to create your avatar..."}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex h-full min-w-0 bg-[var(--color-bg)]">
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Avatar Header */}
      {shouldRenderHeader ? (
        <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
          <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 lg:gap-4">
            {/* Hamburger menu - mobile only */}
            {onMenuClick && (
              <button
                onClick={onMenuClick}
                className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
                aria-label="Open menu"
                data-testid="menu-button"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            <AvatarDisplay avatar={activeAvatar} size="md" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate">{activeAvatar.name}</h1>
                {/* Activation status badge — always visible */}
                {accessMode === 'admin' && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider flex-shrink-0 ${
                      activeAvatar.status === 'active'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : activeAvatar.status === 'paused'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      activeAvatar.status === 'active'
                        ? 'bg-green-400'
                        : activeAvatar.status === 'paused'
                        ? 'bg-amber-400'
                        : 'bg-gray-400'
                    }`} />
                    {activeAvatar.status === 'active' ? 'Live' : activeAvatar.status === 'paused' ? 'Paused' : 'Draft'}
                  </span>
                )}
              </div>
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
              <>
                {/* Activation toggle button */}
                {activeAvatar.status === 'active' ? (
                  <button
                    onClick={handleActivationToggle}
                    disabled={activationLoading}
                    className={`px-2 lg:px-3 py-1.5 text-xs lg:text-sm rounded-lg transition-colors flex items-center gap-1.5 ${
                      activationLoading
                        ? 'opacity-50 cursor-not-allowed text-[var(--color-text-tertiary)]'
                        : 'text-amber-400 hover:bg-amber-900/20 hover:text-amber-300'
                    }`}
                    title="Pause avatar — platform integrations will stop responding"
                  >
                    {activationLoading ? (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
                      </svg>
                    )}
                    <span className="hidden sm:inline">Pause</span>
                  </button>
                ) : (
                  <button
                    onClick={handleActivationToggle}
                    disabled={activationLoading}
                    className={`px-2 lg:px-3 py-1.5 text-xs lg:text-sm rounded-lg transition-colors flex items-center gap-1.5 ${
                      activationLoading
                        ? 'opacity-50 cursor-not-allowed text-[var(--color-text-tertiary)]'
                        : 'text-green-400 bg-green-500/10 hover:bg-green-500/20 hover:text-green-300 border border-green-500/30'
                    }`}
                    title="Activate avatar — platform integrations will start responding"
                  >
                    {activationLoading ? (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                      </svg>
                    )}
                    <span className="hidden sm:inline">Activate</span>
                  </button>
                )}
                <button
                  onClick={() => setPlanUsagePanelOpen(!planUsagePanelOpen)}
                  className={`px-2 lg:px-3 py-1.5 text-xs lg:text-sm transition-colors rounded-lg ${planUsagePanelOpen ? "text-brand-400 bg-brand-900/20" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"}`}
                  title="View plan and usage"
                >
                  Plan & Usage
                </button>
                <button
                  onClick={() => setGalleryPanelOpen(!galleryPanelOpen)}
                  className={`px-2 lg:px-3 py-1.5 text-xs lg:text-sm transition-colors rounded-lg ${galleryPanelOpen ? "text-brand-400 bg-brand-900/20" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"}`}
                  title="View gallery"
                >
                  <span className="hidden sm:inline">Gallery</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                    <path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25v9.5A2.25 2.25 0 0116.75 17H3.25A2.25 2.25 0 011 14.75v-9.5zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 00.75-.75v-2.69l-2.22-2.219a.75.75 0 00-1.06 0l-1.91 1.909-4.97-4.969a.75.75 0 00-1.06 0L1.5 11.06zm12.22-5.81a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  onClick={() => setPromptPreviewOpen(true)}
                  className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
                  title="Preview prompt sent to LLM"
                >
                  <span className="hidden sm:inline">Preview</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                    <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                    <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  onClick={() => clearChat(activeAvatar.id)}
                  className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
                >
                  <span className="hidden sm:inline">Clear Chat</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            )}
          </div>
          </div>
        </header>
      ) : null}

      {/* Deactivation confirmation banner */}
      {showDeactivateConfirm && activeAvatar && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 lg:px-6 py-3">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-amber-300">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 flex-shrink-0">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              <span>Pausing will stop all platform integrations (Discord, Telegram, Twitter) from responding.</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={handleCancelDeactivate}
                className="px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleActivationToggle}
                disabled={activationLoading}
                className="px-3 py-1.5 text-xs text-amber-100 bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {activationLoading ? 'Pausing...' : 'Confirm Pause'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Activation error banner */}
      {activationError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 lg:px-6 py-2">
          <div className="max-w-3xl mx-auto flex items-center gap-2 text-sm text-red-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 flex-shrink-0">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <span>{activationError}</span>
            <button onClick={() => setActivationError(null)} className="ml-auto p-1 hover:bg-red-500/20 rounded">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Warning: platforms configured but avatar not active */}
      {hasConfiguredPlatformsButInactive && accessMode === 'admin' && !showDeactivateConfirm && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 lg:px-6 py-2">
          <div className="max-w-3xl mx-auto flex items-center gap-2 text-xs text-amber-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 flex-shrink-0">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <span>
              Platform integrations are configured but this avatar is not active. Click <strong>Activate</strong> above to go live.
            </span>
          </div>
        </div>
      )}

      {/* Inline Plan & Usage Panel (chat-first) */}
      {planUsagePanelOpen && activeAvatar && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 px-3 lg:px-6 py-3">
          <div className="max-w-3xl mx-auto">
            <PlanUsagePanel
              avatarId={activeAvatar.id}
              avatarName={activeAvatar.name}
              canEdit={account?.role === 'admin'}
              onClose={() => setPlanUsagePanelOpen(false)}
              initialInviteCode={initialInviteCode}
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 lg:px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4 w-full">
          {/* Activation checklist for admin users with newly created avatars */}
          {accessMode === 'admin' && activeAvatar && (
            <ActivationChecklist
              avatar={activeAvatar}
              onSuggest={handleSendMessage}
            />
          )}
          {/* Show welcome message with action chips when the only message is the seeded welcome */}
          {messages.length === 1 && messages[0].id === 'welcome' && activeAvatar ? (
            <WelcomeMessage
              avatarName={activeAvatar.name}
              onAction={handleSendMessage}
            />
          ) : (
            timeline.map((item) => {
              if (item.type === 'task-card') {
                return (
                  <TaskCardComponent
                    key={`tc-${item.card.id}`}
                    cardId={item.card.id}
                    onSubmit={handleToolSubmit}
                    disabled={!handleToolSubmit}
                  />
                );
              }
              const message = item.message;
              // Show upgrade nudge inline after limit-error messages (once per limit type per session)
              const shouldShowNudge = Boolean(
                message.limitInfo &&
                activeAvatar?.id &&
                !shownNudgesRef.current.has(message.limitInfo.limitType)
              );
              if (shouldShowNudge && message.limitInfo) {
                shownNudgesRef.current.add(message.limitInfo.limitType);
              }
              return (
                <div key={message.id}>
                  <ChatMessageComponent
                    message={message}
                    onToolSubmit={handleToolSubmit}
                  />
                  {shouldShowNudge && message.limitInfo && activeAvatar && (
                    <UpgradeNudge
                      avatarId={activeAvatar.id}
                      limitInfo={message.limitInfo as { limitType: 'messages' | 'media' | 'voice' | 'tools'; current: number; limit: number; remaining: number }}
                    />
                  )}
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area - varies by access mode */}
      {accessMode === 'browse' ? (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-4">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Sign in to chat with this avatar
            </p>
          </div>
        </div>
      ) : accessMode === 'limited' ? (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto space-y-2">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} />
            <div className="flex items-center justify-center gap-2 text-xs text-amber-400">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Limited mode • Get an Orb to unlock full access and more slots</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} />
          </div>
        </div>
      )}

      {/* Prompt Preview Panel */}
      <PromptPreviewPanel
        isOpen={promptPreviewOpen}
        onClose={() => setPromptPreviewOpen(false)}
      />

    </div>

    {/* Gallery Sidebar Panel */}
    {activeAvatar && (
      <GalleryPanel
        avatarId={activeAvatar.id}
        isOpen={galleryPanelOpen}
        onClose={() => setGalleryPanelOpen(false)}
      />
    )}

    {/* Task Workspace Panel */}
    <TaskWorkspace />

    </div>
  );
}
