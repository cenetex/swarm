/**
 * Hook encapsulating all Telegram-specific integration state and side effects.
 */
import { useState, useRef, useEffect } from 'react';
import { API_BASE } from '../types';
import type {
  TelegramDiagnosis,
  TelegramUserRef,
  TelegramChatRef,
  KnownTelegramUser,
} from './types';

export interface TelegramConfigState {
  // Policy state
  allowedDmUsers: TelegramUserRef[];
  setAllowedDmUsers: React.Dispatch<React.SetStateAction<TelegramUserRef[]>>;
  allowedChats: TelegramChatRef[];
  setAllowedChats: React.Dispatch<React.SetStateAction<TelegramChatRef[]>>;
  newDmInput: string;
  setNewDmInput: (v: string) => void;
  newGroupInput: string;
  setNewGroupInput: (v: string) => void;
  dmInputError: string | null;
  setDmInputError: (v: string | null) => void;
  groupInputError: string | null;
  setGroupInputError: (v: string | null) => void;
  isResolvingGroup: boolean;
  setIsResolvingGroup: (v: boolean) => void;
  policyLoadError: string | null;
  hasPolicyChanges: boolean;

  // Diagnostics
  diagnosis: TelegramDiagnosis | null;
  diagnosisError: string | null;
  diagnosisLoading: boolean;
  repairLoading: boolean;
  repairError: string | null;

  // Known users
  knownUsers: KnownTelegramUser[];

  // Actions
  runDiagnostics: () => Promise<TelegramDiagnosis | null>;
  repairWebhook: () => Promise<void>;
  saveTelegramPolicy: (avatarId: string) => Promise<void>;

  // Ref for initial policy (used by parent to detect changes)
  initialPolicyRef: React.MutableRefObject<{ allowedDmUsers: TelegramUserRef[]; allowedChats: TelegramChatRef[] } | null>;
}

export function useTelegramConfig(
  avatarId: string | undefined,
  isActive: boolean,
  toolCallId: string,
): TelegramConfigState {
  const [allowedDmUsers, setAllowedDmUsers] = useState<TelegramUserRef[]>([]);
  const [allowedChats, setAllowedChats] = useState<TelegramChatRef[]>([]);
  const [newDmInput, setNewDmInput] = useState('');
  const [newGroupInput, setNewGroupInput] = useState('');
  const [dmInputError, setDmInputError] = useState<string | null>(null);
  const [groupInputError, setGroupInputError] = useState<string | null>(null);
  const [isResolvingGroup, setIsResolvingGroup] = useState(false);
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null);
  const initialPolicyRef = useRef<{ allowedDmUsers: TelegramUserRef[]; allowedChats: TelegramChatRef[] } | null>(null);

  const [diagnosis, setDiagnosis] = useState<TelegramDiagnosis | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [repairLoading, setRepairLoading] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [knownUsers, setKnownUsers] = useState<KnownTelegramUser[]>([]);

  // Reset on new tool call
  useEffect(() => {
    setAllowedDmUsers([]);
    setAllowedChats([]);
    setNewDmInput('');
    setNewGroupInput('');
    setDmInputError(null);
    setGroupInputError(null);
    setIsResolvingGroup(false);
    setPolicyLoadError(null);
    initialPolicyRef.current = null;
    setDiagnosis(null);
    setDiagnosisError(null);
    setDiagnosisLoading(false);
    setRepairLoading(false);
    setRepairError(null);
    setKnownUsers([]);
  }, [toolCallId]);

  // ----- API calls ----- //

  const runDiagnostics = async (): Promise<TelegramDiagnosis | null> => {
    if (!avatarId) return null;
    setDiagnosisLoading(true);
    setDiagnosisError(null);
    try {
      const resp = await fetch(`${API_BASE}/avatars/${avatarId}/telegram/diagnose`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message =
          (payload as { error?: string; message?: string }).error ||
          (payload as { error?: string; message?: string }).message ||
          `Failed to run Telegram diagnostics (HTTP ${resp.status})`;
        setDiagnosis(null);
        setDiagnosisError(message);
        return null;
      }
      const d = payload as TelegramDiagnosis;
      d.issues = d.issues ?? [];
      setDiagnosis(d);
      return d;
    } catch {
      setDiagnosis(null);
      setDiagnosisError('Failed to run Telegram diagnostics');
      return null;
    } finally {
      setDiagnosisLoading(false);
    }
  };

  const repairWebhook = async (): Promise<void> => {
    if (!avatarId) return;
    setRepairLoading(true);
    setRepairError(null);
    try {
      const resp = await fetch(`${API_BASE}/avatars/${avatarId}/telegram/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          dryRun: false,
          repairOnPendingUpdates: true,
          repairOnLastError: true,
        }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message =
          (payload as { error?: string; message?: string }).error ||
          (payload as { error?: string; message?: string }).message ||
          `Failed to repair webhook (HTTP ${resp.status})`;
        setRepairError(message);
        return;
      }
      const result = payload as { action?: string; reason?: string };
      if (result.action === 'repaired') {
        await runDiagnostics();
      } else if (result.action === 'skipped') {
        setRepairError(`Skipped: ${result.reason || 'No repair needed'}`);
      }
    } catch {
      setRepairError('Failed to repair webhook');
    } finally {
      setRepairLoading(false);
    }
  };

  const saveTelegramPolicy = async (aid: string): Promise<void> => {
    const policyResponse = await fetch(`${API_BASE}/avatars/${aid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        platforms: {
          telegram: {
            allowedDmUsers,
            allowedChats,
            allowedDmUserIds: allowedDmUsers.map((u) => u.userId),
            allowedChatIds: allowedChats.map((c) => c.chatId),
          },
        },
      }),
    });
    if (!policyResponse.ok) {
      const payload = await policyResponse.json().catch(() => ({}));
      throw new Error(
        (payload as { error?: string; message?: string }).error ||
          (payload as { error?: string; message?: string }).message ||
          `Failed to save Telegram policy (HTTP ${policyResponse.status})`,
      );
    }
    initialPolicyRef.current = {
      allowedDmUsers: [...allowedDmUsers],
      allowedChats: [...allowedChats],
    };
  };

  // ----- Side effects ----- //

  // Diagnose + auto-repair on mount
  useEffect(() => {
    if (!isActive || !avatarId) return;

    const diagnoseAndRepair = async () => {
      const d = await runDiagnostics();
      if (!d) return;
      const hasFixableIssues = (d.issues ?? []).some(
        (i) =>
          i.code === 'webhook_url_mismatch' ||
          i.code === 'webhook_pending_updates' ||
          i.code === 'webhook_last_error',
      );
      if (hasFixableIssues) {
        await repairWebhook();
      }
    };

    const fetchKnownUsers = async () => {
      try {
        const resp = await fetch(`${API_BASE}/avatars/${avatarId}/telegram/known-users`, {
          method: 'GET',
          credentials: 'include',
        });
        if (resp.ok) {
          const data = (await resp.json()) as { users: KnownTelegramUser[] };
          setKnownUsers(data.users || []);
        }
      } catch {
        // Silently ignore - known users is a nice-to-have
      }
    };

    void diagnoseAndRepair();
    void fetchKnownUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId, isActive, avatarId]);

  // Load existing policy
  useEffect(() => {
    if (!isActive || !avatarId) return;

    const run = async () => {
      setPolicyLoadError(null);
      try {
        const response = await fetch(`${API_BASE}/avatars/${avatarId}`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) {
          setPolicyLoadError(`Failed to load current Telegram settings (HTTP ${response.status})`);
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as {
          platforms?: {
            telegram?: {
              allowedDmUserIds?: string[];
              allowedChatIds?: string[];
              allowedDmUsers?: TelegramUserRef[];
              allowedChats?: TelegramChatRef[];
            };
          };
        };
        const telegram = payload?.platforms?.telegram || {};

        let dmUsers: TelegramUserRef[];
        let chats: TelegramChatRef[];

        if (telegram.allowedDmUsers && telegram.allowedDmUsers.length > 0) {
          dmUsers = telegram.allowedDmUsers;
        } else if (telegram.allowedDmUserIds && telegram.allowedDmUserIds.length > 0) {
          dmUsers = normalizeList(telegram.allowedDmUserIds).map((id) => ({ userId: id }));
        } else {
          dmUsers = [];
        }

        if (telegram.allowedChats && telegram.allowedChats.length > 0) {
          chats = telegram.allowedChats;
        } else if (telegram.allowedChatIds && telegram.allowedChatIds.length > 0) {
          chats = normalizeList(telegram.allowedChatIds).map((id) => ({ chatId: id }));
        } else {
          chats = [];
        }

        setAllowedDmUsers(dmUsers);
        setAllowedChats(chats);
        initialPolicyRef.current = { allowedDmUsers: dmUsers, allowedChats: chats };
      } catch {
        setPolicyLoadError('Failed to load current Telegram settings');
      }
    };

    void run();
  }, [isActive, avatarId]);

  // ----- Derived ----- //

  const hasPolicyChanges = (() => {
    if (!isActive) return false;
    if (!initialPolicyRef.current) return false;
    const currentDmIds = allowedDmUsers.map((u) => u.userId).sort();
    const currentChatIds = allowedChats.map((c) => c.chatId).sort();
    const initialDmIds = initialPolicyRef.current.allowedDmUsers.map((u) => u.userId).sort();
    const initialChatIds = initialPolicyRef.current.allowedChats.map((c) => c.chatId).sort();
    return (
      JSON.stringify({ dm: currentDmIds, chat: currentChatIds }) !==
      JSON.stringify({ dm: initialDmIds, chat: initialChatIds })
    );
  })();

  return {
    allowedDmUsers,
    setAllowedDmUsers,
    allowedChats,
    setAllowedChats,
    newDmInput,
    setNewDmInput,
    newGroupInput,
    setNewGroupInput,
    dmInputError,
    setDmInputError,
    groupInputError,
    setGroupInputError,
    isResolvingGroup,
    setIsResolvingGroup,
    policyLoadError,
    hasPolicyChanges,
    diagnosis,
    diagnosisError,
    diagnosisLoading,
    repairLoading,
    repairError,
    knownUsers,
    runDiagnostics,
    repairWebhook,
    saveTelegramPolicy,
    initialPolicyRef,
  };
}

// ----- Helpers ----- //

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v).trim()).filter(Boolean);
}
