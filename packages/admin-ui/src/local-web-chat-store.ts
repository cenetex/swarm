export type LocalChatMessage = {
  role: string;
  content: string;
  media?: unknown[];
};

export type LocalChatPage = {
  history: LocalChatMessage[];
  nextCursor: string | null;
};

export const MAX_LOCAL_CHAT_MESSAGES = 100;
export const MAX_LOCAL_CHAT_CONTENT_CHARS = 32_000;
export const MAX_LOCAL_CHAT_CONVERSATIONS = 50;
const MAX_LOCAL_CHAT_MEDIA_ITEMS = 8;
const MAX_LOCAL_CHAT_MEDIA_ITEM_CHARS = 16_000;

const DATABASE_NAME = 'swarm-web-local';
const DATABASE_VERSION = 1;
const STORE_NAME = 'chat-histories';
const memoryFallback = new Map<string, LocalChatMessage[]>();

let databasePromise: Promise<IDBDatabase> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local chat storage'));
  });

  return databasePromise;
}

function normalizeMedia(media: unknown): unknown[] | undefined {
  if (!Array.isArray(media)) return undefined;
  const bounded = media.slice(0, MAX_LOCAL_CHAT_MEDIA_ITEMS).filter((item) => {
    try {
      return JSON.stringify(item).length <= MAX_LOCAL_CHAT_MEDIA_ITEM_CHARS;
    } catch {
      return false;
    }
  });
  return bounded.length > 0 ? bounded : undefined;
}

function normalizeMessage(message: LocalChatMessage): LocalChatMessage {
  const media = normalizeMedia(message.media);
  return {
    role: message.role.slice(0, 32),
    content: message.content.slice(0, MAX_LOCAL_CHAT_CONTENT_CHARS),
    ...(media ? { media } : {}),
  };
}

function cloneHistory(history: LocalChatMessage[]): LocalChatMessage[] {
  return history.map(normalizeMessage);
}

function pruneMemory(preserveAvatarId: string): void {
  while (memoryFallback.size > MAX_LOCAL_CHAT_CONVERSATIONS) {
    const oldest = [...memoryFallback.keys()].find((key) => key !== 'global' && key !== preserveAvatarId);
    if (!oldest) return;
    memoryFallback.delete(oldest);
  }
}

async function pruneDatabase(db: IDBDatabase, preserveAvatarId: string): Promise<void> {
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to inspect local chat storage'));
  });
  const excess = keys.length - MAX_LOCAL_CHAT_CONVERSATIONS;
  if (excess <= 0) return;
  const removable = keys
    .map(String)
    .filter((key) => key !== 'global' && key !== preserveAvatarId)
    .sort()
    .slice(0, excess);
  if (removable.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const key of removable) store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to prune local chat storage'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local chat prune was aborted'));
  });
}

async function readHistory(avatarId: string): Promise<LocalChatMessage[]> {
  const database = openDatabase();
  if (!database) return cloneHistory(memoryFallback.get(avatarId) ?? []);

  try {
    const db = await database;
    return await new Promise<LocalChatMessage[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(avatarId);
      request.onsuccess = () => resolve(cloneHistory(Array.isArray(request.result) ? request.result : []));
      request.onerror = () => reject(request.error ?? new Error('Unable to read local chat history'));
    });
  } catch {
    return cloneHistory(memoryFallback.get(avatarId) ?? []);
  }
}

async function writeHistory(avatarId: string, history: LocalChatMessage[]): Promise<void> {
  const bounded = cloneHistory(history.slice(-MAX_LOCAL_CHAT_MESSAGES));
  memoryFallback.delete(avatarId);
  memoryFallback.set(avatarId, bounded);
  pruneMemory(avatarId);
  const database = openDatabase();
  if (!database) return;

  try {
    const db = await database;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(bounded, avatarId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to write local chat history'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local chat write was aborted'));
    });
    await pruneDatabase(db, avatarId);
  } catch {
    // The in-memory copy keeps the current tab usable if IndexedDB is unavailable.
  }
}

function queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function sanitizeLocalChatHistories(value: unknown): Record<string, LocalChatMessage[]> {
  if (!value || typeof value !== 'object') return {};
  const histories: Record<string, LocalChatMessage[]> = {};
  for (const [avatarId, history] of Object.entries(value)) {
    if (!Array.isArray(history)) continue;
    histories[avatarId] = history
      .filter((message): message is LocalChatMessage => (
        Boolean(message)
        && typeof message === 'object'
        && typeof (message as { role?: unknown }).role === 'string'
        && typeof (message as { content?: unknown }).content === 'string'
      ))
      .slice(-MAX_LOCAL_CHAT_MESSAGES)
      .map(normalizeMessage);
  }
  return histories;
}

export const localWebChatStore = {
  async getPage(avatarId: string, limit = MAX_LOCAL_CHAT_MESSAGES, before?: string | null): Promise<LocalChatPage> {
    await mutationQueue;
    const history = await readHistory(avatarId);
    const boundedLimit = Math.min(MAX_LOCAL_CHAT_MESSAGES, Math.max(1, Math.floor(limit) || MAX_LOCAL_CHAT_MESSAGES));
    const parsedCursor = before === null || before === undefined ? history.length : Number.parseInt(before, 10);
    const end = Number.isFinite(parsedCursor)
      ? Math.min(history.length, Math.max(0, parsedCursor))
      : history.length;
    const start = Math.max(0, end - boundedLimit);
    return {
      history: history.slice(start, end),
      nextCursor: start > 0 ? String(start) : null,
    };
  },

  replaceHistory(avatarId: string, history: LocalChatMessage[]): Promise<void> {
    return queueMutation(() => writeHistory(avatarId, history));
  },

  append(avatarId: string, messages: LocalChatMessage[]): Promise<LocalChatMessage[]> {
    return queueMutation(async () => {
      const history = await readHistory(avatarId);
      const nextHistory = [...history, ...messages].slice(-MAX_LOCAL_CHAT_MESSAGES);
      await writeHistory(avatarId, nextHistory);
      return nextHistory;
    });
  },

  deleteHistory(avatarId: string): Promise<void> {
    return queueMutation(async () => {
      memoryFallback.delete(avatarId);
      const database = openDatabase();
      if (!database) return;
      try {
        const db = await database;
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, 'readwrite');
          transaction.objectStore(STORE_NAME).delete(avatarId);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('Unable to delete local chat history'));
          transaction.onabort = () => reject(transaction.error ?? new Error('Local chat delete was aborted'));
        });
      } catch {
        // The in-memory copy was already cleared.
      }
    });
  },

  migrateLegacy(histories: Record<string, LocalChatMessage[]>): Promise<void> {
    return queueMutation(async () => {
      for (const [avatarId, history] of Object.entries(histories)) {
        await writeHistory(avatarId, history);
      }
    });
  },
};
