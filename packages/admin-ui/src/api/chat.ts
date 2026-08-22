import { API_BASE } from './apiBase';

/**
 * Check if we're on a public subdomain (e.g., agent-name.rati.chat)
 * Reserved subdomains are excluded from public access mode
 */
function isPublicSubdomain(): boolean {
  const hostname = window.location.hostname.split(':')[0]?.toLowerCase() || '';
  if (!hostname.endsWith('.rati.chat')) return false;

  const reserved = new Set([
    'swarm',
    'staging-swarm',
    'admin',
    'api',
    'cdn',
    'gallery',
    'docs',
  ]);

  const [subdomain] = hostname.split('.');
  if (!subdomain || reserved.has(subdomain) || subdomain.startsWith('admin-') || subdomain.startsWith('api-')) {
    return false;
  }

  return true;
}

/**
 * Get URL with publicAccess parameter if on a public subdomain
 */
function getChatUrl(path: string = ''): string {
  const publicAccess = isPublicSubdomain();
  const url = `${API_BASE}/chat${path}`;
  return publicAccess ? `${url}${path ? '&' : '?'}publicAccess=true` : url;
}

export interface LimitErrorInfo {
  limitType: 'messages' | 'media' | 'voice' | 'tools';
  current: number;
  limit: number;
  remaining: number;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface MediaItem {
  type: 'image' | 'video' | 'sticker' | 'audio';
  url: string;
  prompt?: string;
  id?: string;
}

interface PendingJob {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  prompt?: string;
  purpose?: string;
}

interface RateLimitInfo {
  remaining: number;
  limit: number;
  isOrbHolder: boolean;
}

/** Structured task action from tool results — creates transcript cards and workspace suggestions */
export interface TaskActionPayload {
  toolCallId: string;
  toolName: string;
  taskAction: {
    task: {
      type: 'tool_prompt' | 'gallery' | 'wallet_link' | 'integration_config' | 'document' | 'diagnostics';
      title: string;
      summary?: string;
      props?: Record<string, unknown>;
    };
    workspace?: {
      focus: boolean;
      surface?: 'side_panel' | 'bottom_drawer';
    };
  };
}

export interface AvatarUpdates {
  profileImageUrl?: string;
  name?: string;
}

export interface ChatResponse {
  response: string;
  history: Array<{
    role: string;
    content: string;
    thinking?: string[];
    tool_calls?: unknown[];
    media?: MediaItem[];
  }>;
  media?: MediaItem[];
  pendingJobs?: PendingJob[];
  avatarUpdates?: AvatarUpdates;
  pendingToolCall?: PendingToolCall;
  taskActions?: TaskActionPayload[];
  error?: string;
  rateLimit?: RateLimitInfo;
}

interface AvatarContext {
  id: string;
  name: string;
  description?: string;
  persona?: string;
}

interface SenderContext {
  walletAddress?: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Concise snapshot of the user's active task (sent as request metadata). */
export interface ActiveTaskMeta {
  taskId: string;
  toolName: string;
  status: string;
  surface: 'inline' | 'workspace';
}

/**
 * Send a chat message to the admin API
 */
export async function sendChatMessage(
  message: string,
  history: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
  avatar?: AvatarContext,
  sender?: SenderContext,
  activeTask?: ActiveTaskMeta,
): Promise<ChatResponse> {
  const response = await fetch(getChatUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ask the API to return immediately with a jobId (avoids Lambda/API Gateway timeouts)
      'Prefer': 'respond-async',
    },
    credentials: 'include',
    body: JSON.stringify({
      message,
      history: history.map((m) => ({
        role: m.role,
        content: m.content ?? '',
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
      })),
      // Pass avatar context so the LLM knows which avatar it IS
      avatar: avatar ? {
        id: avatar.id,
        name: avatar.name,
        description: avatar.description,
        persona: avatar.persona,
      } : undefined,
      // Pass sender context for message attribution
      sender: sender ? {
        walletAddress: sender.walletAddress,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl,
      } : undefined,
      // Pass active task context for system prompt enrichment
      activeTask: activeTask || undefined,
    }),
  });

  // Async path: API returns a jobId, UI polls /jobs until completion
  if (response.status === 202) {
    const data = await response.json().catch(() => null) as { jobId?: string } | null;
    const jobId = data?.jobId;
    if (!jobId) {
      throw new Error('Async chat requested but no jobId returned');
    }

    const job = await pollJobCompletion(jobId);
    if (job.type !== 'chat') {
      throw new Error(`Unexpected job type for chat: ${job.type}`);
    }
    if (job.status !== 'completed') {
      throw new Error(job.error || `Chat job ${job.status}`);
    }

    return {
      response: job.response || '',
      history: job.history || [],
      media: job.media,
      pendingJobs: job.pendingJobs,
      pendingToolCall: job.pendingToolCall,
      avatarUpdates: job.avatarUpdates,
      taskActions: job.taskActions,
    };
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    const err = new Error(error.error || `HTTP ${response.status}`);
    // Attach structured limit info for upgrade nudge rendering
    if (response.status === 429 && error.limitType) {
      (err as Error & { limitInfo?: LimitErrorInfo }).limitInfo = {
        limitType: error.limitType,
        current: error.current,
        limit: error.limit,
        remaining: error.remaining ?? 0,
      };
    }
    throw err;
  }

  return response.json();
}

/**
 * Submit a tool call result (e.g., secret input)
 */
export async function submitToolResult(
  avatarId: string,
  toolCallId: string,
  result: unknown
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/tools/${toolCallId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ result }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error('Unexpected server response. Please refresh and try again.');
  }

  return response.json();
}

/**
 * Save a secret for an avatar
 */
export async function saveAvatarSecret(
  avatarId: string,
  secretKey: string,
  secretValue: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/secrets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ key: secretKey, value: secretValue }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Check if user is authenticated
 */
export async function checkAuth(): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const response = await fetch(`${API_BASE}/health`, {
      credentials: 'include',
    });
    
    if (response.ok) {
      return { authenticated: true };
    }
    
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Fetch chat history from backend (for cross-device sync)
 */
export async function fetchChatHistory(
  avatarId?: string
): Promise<Array<{ role: string; content: string; media?: MediaItem[] }>> {
  const publicAccess = isPublicSubdomain();
  let url = `${API_BASE}/chat`;
  const params = new URLSearchParams();
  if (avatarId) params.set('avatarId', avatarId);
  if (publicAccess) params.set('publicAccess', 'true');
  const paramStr = params.toString();
  if (paramStr) url += `?${paramStr}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.history || [];
}

/**
 * Clear chat history on the backend
 */
export async function clearChatHistory(avatarId?: string): Promise<void> {
  const publicAccess = isPublicSubdomain();
  let url = `${API_BASE}/chat`;
  const params = new URLSearchParams();
  if (avatarId) params.set('avatarId', avatarId);
  if (publicAccess) params.set('publicAccess', 'true');
  const paramStr = params.toString();
  if (paramStr) url += `?${paramStr}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Append a system message to chat history
 * Used for status updates (OAuth success, errors, etc.) that both AI and users should see
 */
export async function appendSystemMessage(
  avatarId: string,
  message: { role: 'assistant' | 'user'; content: string }
): Promise<Array<{ role: string; content: string; media?: MediaItem[] }>> {
  const publicAccess = isPublicSubdomain();
  const url = publicAccess ? `${API_BASE}/chat/message?publicAccess=true` : `${API_BASE}/chat/message`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      avatarId,
      message,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.history || [];
}

// ============================================================================
// Job Status Polling (for async image/video generation)
// ============================================================================

export interface JobStatus {
  jobId: string;
  type: 'image' | 'video' | 'sticker' | 'chat';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resultUrl?: string;
  url?: string; // Alias for resultUrl for compatibility
  error?: string;

  // Chat job result fields (present when type === 'chat')
  response?: string;
  history?: ChatResponse['history'];
  media?: MediaItem[];
  pendingJobs?: PendingJob[];
  pendingToolCall?: PendingToolCall;
  avatarUpdates?: ChatResponse['avatarUpdates'];
  taskActions?: TaskActionPayload[];
}

/**
 * Get the status of a specific job
 */
export async function getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.message || error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get all pending jobs for an avatar
 */
export async function getPendingJobs(avatarId: string): Promise<{ count: number; jobs: JobStatus[] }> {
  const response = await fetch(`${API_BASE}/jobs?avatarId=${encodeURIComponent(avatarId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.message || error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Poll for job completion
 * Returns the completed job status or throws if the job fails
 */
export async function pollJobCompletion(
  jobId: string,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
    maxIntervalMs?: number;
    backoffFactor?: number;
    onProgress?: (status: JobStatus) => void;
    signal?: AbortSignal;
  } = {}
): Promise<JobStatus> {
  const {
    maxAttempts = 120,
    intervalMs = 2000,
    maxIntervalMs = 12000,
    backoffFactor = 1.5,
    onProgress,
    signal,
  } = options;
  let currentInterval = intervalMs;

  const createAbortError = () => {
    const err = new Error('Polling cancelled');
    (err as Error & { name: string }).name = 'AbortError';
    return err;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const status = await getJobStatus(jobId, signal);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'completed') {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(status.error || 'Job failed');
    }

    // Wait before next poll
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(resolve, currentInterval);
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    currentInterval = Math.min(Math.floor(currentInterval * backoffFactor), maxIntervalMs);
  }

  throw new Error('Job timed out');
}

/**
 * Transcribe audio using the backend API
 * Uploads audio blob and returns transcribed text
 */
export async function transcribeAudio(
  audioBlob: Blob,
  avatarId?: string
): Promise<{ text: string; language?: string }> {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  if (avatarId) {
    formData.append('avatarId', avatarId);
  }

  const response = await fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Transcription failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
