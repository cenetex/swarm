import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useAvatarStore } from './store';
import { useAuth } from './store/auth';
import { useConsentStore, CURRENT_POLICY_VERSION } from './store/consent';
import { bootstrapAuthFromBackendSession } from './auth/bootstrap';
import { getTwitterConnectionStatus } from './api/twitter';
import { appendSystemMessage } from './api/chat';
import { AvatarSidebar, ChatPanel } from './components';
import { ConsentBanner } from './components/ConsentBanner';

// Lazy-load route-level components that aren't always needed
const LandingPage = lazy(() => import('./components/LandingPage').then(m => ({ default: m.LandingPage })));
const PublicChatPage = lazy(() => import('./components/PublicChatPage').then(m => ({ default: m.PublicChatPage })));

function LazyFallback() {
  return (
    <div className="flex-1 flex items-center justify-center bg-[var(--color-bg)]">
      <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

const TWITTER_OAUTH_STORAGE_KEY = 'swarm:oauth:twitter:lastResult';

type TwitterOAuthResult =
  | { status: 'connected'; avatarId?: string; username: string; ts: number }
  | { status: 'error'; avatarId?: string; error: string; ts: number };

function getChatAvatarId(pathname: string): string | null {
  // Chat deep link: /avatars/:id
  const match = pathname.match(/^\/avatars\/([^/]+)\/?$/);
  return match?.[1] || null;
}

function getAvatarIdFromAvatarPath(pathname: string): string | null {
  return getChatAvatarId(pathname);
}

function getBotIdFromHostname(hostname: string): string | null {
  const normalizedRaw = hostname.split(':')[0]?.toLowerCase();
  const normalized = normalizedRaw?.replace(/\.$/, '');
  if (!normalized || !normalized.endsWith('.rati.chat')) return null;

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
  if (!subdomain || reserved.has(subdomain) || subdomain.startsWith('admin-') || subdomain.startsWith('api-')) {
    return null;
  }

  return subdomain;
}

function parseTwitterOAuthResultFromLocation(location: Location): TwitterOAuthResult | null {
  const params = new URLSearchParams(location.search);
  const connected = params.get('twitter_connected');
  const error = params.get('twitter_error');
  if (!connected && !error) return null;

  const avatarIdFromPath = getAvatarIdFromAvatarPath(location.pathname);
  const ts = Date.now();

  if (connected) {
    return { status: 'connected', avatarId: avatarIdFromPath || undefined, username: connected, ts };
  }
  return { status: 'error', avatarId: avatarIdFromPath || undefined, error: error || 'unknown', ts };
}

function App() {
  const { avatars, fetchAvatars, activeAvatarId, syncChatHistory, setActiveAvatar, addMessage, updateMessage } = useAvatarStore();
  // Use unified auth state for backend session + Privy login.
  const { isAuthenticated } = useAuth();
  const consent = useConsentStore((s) => s.consent);
  const [initialized, setInitialized] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatAvatarId, setChatAvatarId] = useState<string | null>(
    () => getChatAvatarId(window.location.pathname)
  );
  const [pendingOAuthResult, setPendingOAuthResult] = useState<TwitterOAuthResult | null>(
    () => parseTwitterOAuthResultFromLocation(window.location)
  );
  const [chatSynced, setChatSynced] = useState(false);

  // Clean up OAuth query params immediately on mount (before anything else)
  useEffect(() => {
    if (pendingOAuthResult) {
      try {
        const cleanUrl = `${window.location.pathname}`;
        window.history.replaceState({}, '', cleanUrl);
      } catch {
        // ignore
      }
      // Also store in localStorage for cross-tab communication
      try {
        localStorage.setItem(TWITTER_OAUTH_STORAGE_KEY, JSON.stringify(pendingOAuthResult));
      } catch {
        // ignore
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Check auth status on mount (run once)
  useEffect(() => {
    if (authChecked) return; // Already checked
    
    let mounted = true;
    
    const doAuthCheck = async () => {
      await bootstrapAuthFromBackendSession();
      if (mounted) {
        setAuthChecked(true);
      }
    };
    
    // Use a timeout as a fallback
    const timeoutId = setTimeout(() => {
      if (mounted) {
        console.warn('[App] Auth check timeout');
        setAuthChecked(true);
      }
    }, 10000);
    
    doAuthCheck();
    
    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [authChecked]);

  // Sync consent status from backend once authenticated
  useEffect(() => {
    if (!authChecked || !isAuthenticated) return;
    useConsentStore.getState().syncFromBackend().catch(() => {
      // Fallback to localStorage state on error
    });
  }, [authChecked, isAuthenticated]);

  // Fetch avatars from backend once authenticated (run once when conditions are met)
  useEffect(() => {
    if (initialized || !authChecked || !isAuthenticated) return;
    
    let mounted = true;
    
    fetchAvatars()
      .catch(console.error)
      .finally(() => {
        if (mounted) setInitialized(true);
      });
    
    return () => { mounted = false; };
  }, [authChecked, isAuthenticated, fetchAvatars, initialized]);

  // Sync chat history from backend when avatar is selected
  // ALWAYS sync on avatar change to ensure cross-device consistency
  useEffect(() => {
    if (activeAvatarId && initialized) {
      const sync = async () => {
        // Always sync from backend - it's the source of truth for cross-device
        await syncChatHistory(activeAvatarId).catch(console.error);

        // Mark chat as synced so OAuth result can be processed
        setChatSynced(true);
      };

      sync();
    }
  }, [
    activeAvatarId,
    initialized,
    syncChatHistory,
  ]);

  // Close sidebar when avatar is selected on mobile
  useEffect(() => {
    if (activeAvatarId) {
      setSidebarOpen(false);
    }
  }, [activeAvatarId]);

  useEffect(() => {
    const handlePopState = () => {
      setChatAvatarId(getChatAvatarId(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Support deep-linking: select the target avatar once avatars are loaded.
  // Handles /avatars/:id.
  useEffect(() => {
    if (!initialized) return;
    const targetId = chatAvatarId;
    if (!targetId) return;
    const hasAvatar = avatars.some((avatar) => avatar.id === targetId);
    if (hasAvatar && activeAvatarId !== targetId) {
      setActiveAvatar(targetId);
    }
  }, [avatars, activeAvatarId, chatAvatarId, initialized, setActiveAvatar]);

  const handleTwitterOAuthResult = useCallback(async (result: TwitterOAuthResult) => {
    if (result.avatarId) {
      setActiveAvatar(result.avatarId);
    }

    // Refresh avatars so UI reflects connected username/state.
    await fetchAvatars().catch(console.error);

    const targetAvatarId = result.avatarId || activeAvatarId;
    if (!targetAvatarId) return;

    // Source of truth: fetch backend connection status and use that username.
    // This avoids displaying stale/incorrect usernames from query params or cached config.
    let backendUsername: string | undefined;
    let backendConnected: boolean | undefined;
    try {
      const status = await getTwitterConnectionStatus(targetAvatarId);
      backendConnected = status.connected;
      backendUsername = status.username;
    } catch (err) {
      console.warn('[App] Failed to fetch Twitter connection status', err);
    }

    if (result.status === 'connected') {
      const displayUsername = backendUsername || result.username;

      if (backendConnected === false) {
        const disconnectErrorContent = JSON.stringify({
          connected: false,
          error: true,
          message: 'X/Twitter OAuth completed, but backend still reports disconnected. Please refresh and try again.',
        });

        // Persist to backend so AI has context
        await appendSystemMessage(targetAvatarId, {
          role: 'assistant',
          content: disconnectErrorContent,
        }).catch(err => console.warn('[App] Failed to persist OAuth disconnect error:', err));

        addMessage(targetAvatarId, {
          role: 'assistant',
          content: disconnectErrorContent,
        });
        return;
      }

      // Clear any twitter connection tool call messages (pending OR completed - status may have changed when user clicked Connect)
      const avatarChats = useAvatarStore.getState().chats[targetAvatarId] || [];
      for (const msg of avatarChats) {
        if (msg.toolCalls?.some(tc => tc.name === 'request_twitter_connection' || tc.name === 'configure_integration')) {
          const updatedToolCalls = msg.toolCalls.map(tc =>
            (tc.name === 'request_twitter_connection' || tc.name === 'configure_integration')
              ? { ...tc, status: 'completed' as const }
              : tc
          );
          // Clear the message content - the panel handles its own UI
          updateMessage(targetAvatarId, msg.id, {
            toolCalls: updatedToolCalls,
            content: '',
          });
        }
      }

      // Sync history FIRST so subsequent tool calls see updated config
      await syncChatHistory(targetAvatarId).catch(console.error);

      // Build the success message
      const successContent = JSON.stringify({
        connected: true,
        username: displayUsername,
        message: `Connected as @${displayUsername}`,
      });

      // Persist to backend so AI has context and message survives refresh
      await appendSystemMessage(targetAvatarId, {
        role: 'assistant',
        content: successContent,
      }).catch(err => console.warn('[App] Failed to persist OAuth success message:', err));

      // Also update local state for immediate UI feedback
      addMessage(targetAvatarId, {
        role: 'assistant',
        content: successContent,
      });

      if (backendUsername && backendUsername !== result.username) {
        const noteContent = `Note: OAuth redirect reported @${result.username}, but backend status reports @${backendUsername}. Using backend status as the source of truth.`;
        await appendSystemMessage(targetAvatarId, {
          role: 'assistant',
          content: noteContent,
        }).catch(err => console.warn('[App] Failed to persist OAuth note:', err));

        addMessage(targetAvatarId, {
          role: 'assistant',
          content: noteContent,
        });
      }
    } else {
      // On error, clear the tool call message (check both pending AND completed status)
      const avatarChats = useAvatarStore.getState().chats[targetAvatarId] || [];
      for (const msg of avatarChats) {
        if (msg.toolCalls?.some(tc => tc.name === 'request_twitter_connection' || tc.name === 'configure_integration')) {
          const updatedToolCalls = msg.toolCalls.map(tc =>
            (tc.name === 'request_twitter_connection' || tc.name === 'configure_integration')
              ? { ...tc, status: 'completed' as const }
              : tc
          );
          updateMessage(targetAvatarId, msg.id, {
            toolCalls: updatedToolCalls,
            content: '',
          });
        }
      }

      // Build the error message
      const errorContent = JSON.stringify({
        connected: false,
        error: true,
        message: `X/Twitter connection failed: ${result.error}`,
      });

      // Persist to backend so AI has context
      await appendSystemMessage(targetAvatarId, {
        role: 'assistant',
        content: errorContent,
      }).catch(err => console.warn('[App] Failed to persist OAuth error message:', err));

      // Update local state
      addMessage(targetAvatarId, {
        role: 'assistant',
        content: errorContent,
      });
    }
  }, [activeAvatarId, addMessage, fetchAvatars, setActiveAvatar, syncChatHistory, updateMessage]);

  // If we're in a popup window (OAuth redirect), close it
  // The main window will handle the result via localStorage storage event
  useEffect(() => {
    if (pendingOAuthResult && window.opener) {
      window.close();
    }
  }, [pendingOAuthResult]);

  // Process pending OAuth result AFTER chat history is synced
  // This ensures the result isn't wiped out by syncChatHistory
  useEffect(() => {
    if (pendingOAuthResult && chatSynced && !window.opener) {
      const result = pendingOAuthResult;
      setPendingOAuthResult(null); // Clear first to prevent re-entry
      void handleTwitterOAuthResult(result);
    }
  }, [pendingOAuthResult, chatSynced, handleTwitterOAuthResult]);

  // Listen for cross-tab OAuth result events.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TWITTER_OAUTH_STORAGE_KEY || !e.newValue) return;
      try {
        const raw: unknown = JSON.parse(e.newValue);
        if (!raw || typeof raw !== 'object') return;

        const maybe = raw as { ts?: unknown };
        // Ignore stale/invalid payloads
        if (typeof maybe.ts !== 'number') return;

        void handleTwitterOAuthResult(raw as TwitterOAuthResult);
      } catch {
        // ignore
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [handleTwitterOAuthResult]);

  // Handle avatar selection from sidebar - updates store, URL, and chatAvatarId state
  const handleSelectAvatar = useCallback((avatarId: string) => {
    setActiveAvatar(avatarId);
    setChatAvatarId(avatarId);
    window.history.pushState({}, '', `/avatars/${avatarId}`);
  }, [setActiveAvatar]);

  // Show loading state while checking auth (only use local authChecked state)
  if (!authChecked) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-[var(--color-bg)]">
        <div className="flex flex-col items-center gap-4">
          <img src="/swarm.svg" alt="Swarm" className="w-12 h-12 animate-pulse" />
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Show landing page for unauthenticated users
  if (!isAuthenticated) {
    return <Suspense fallback={<LazyFallback />}><LandingPage /></Suspense>;
  }

  // Show consent banner if user hasn't accepted privacy policy
  if (!consent || consent.policyVersion !== CURRENT_POLICY_VERSION) {
    return <ConsentBanner />;
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)] relative">
      {/* Safe area spacer for iOS status bar */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg-secondary)]" 
        style={{ height: 'env(safe-area-inset-top, 0px)' }} 
      />
      
      {/* Main content area */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/50 z-20 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile unless toggled */}
        <div className={`
          fixed lg:relative inset-y-0 left-0 z-30 
          transform transition-transform duration-200 ease-in-out will-change-transform
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
          style={{ top: 'env(safe-area-inset-top, 0px)' }}
        >
          <AvatarSidebar onClose={() => setSidebarOpen(false)} onSelectAvatar={handleSelectAvatar} />
        </div>

        {/* Main Route Area */}
        <ChatPanel
          onMenuClick={() => setSidebarOpen(true)}
        />
      </div>
      
      {/* Safe area spacer for iOS home indicator */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg)]" 
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }} 
      />
    </div>
  );
}

export default App;

export function AppRouter() {
  const botIdFromHost = getBotIdFromHostname(window.location.hostname);
  if (botIdFromHost) {
    return <Suspense fallback={<LazyFallback />}><PublicChatPage botId={botIdFromHost} /></Suspense>;
  }
  return <App />;
}
