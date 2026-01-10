/**
 * Tool Context Builder
 * 
 * Provides dynamic context injection into tool descriptions.
 * This pattern enables:
 * 1. Reduced tool call round-trips (LLM has immediate awareness)
 * 2. Contextual decision making (knows what's available NOW)
 * 3. Future multi-channel awareness (activity across Telegram, Discord, Twitter)
 * 
 * Context Levels:
 * - SUMMARY: Brief inline context (e.g., "Recent: img1, img2, img3")
 * - EXPANDED: Full details with metadata
 * - COLLAPSED: No context (original tool description only)
 * 
 * The context level can be adjusted based on:
 * - Token budget constraints
 * - Tool relevance to current task
 * - User preferences
 */

export type ContextLevel = 'collapsed' | 'summary' | 'expanded';

export interface ContextNode<T = unknown> {
  level: ContextLevel;
  summary: string;           // Brief context for tool description
  items: T[];               // Full items for expanded view
  totalCount: number;       // Total available (may be more than items.length)
  lastUpdated: number;      // Timestamp of last context refresh
}

export interface ToolWithContext {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  /** Dynamic context to inject - optional */
  context?: ContextNode;
}

/**
 * Build a context summary string for tool descriptions
 */
export function buildContextSummary<T>(
  items: T[],
  formatter: (item: T) => string,
  options: {
    maxItems?: number;
    emptyMessage?: string;
    prefix?: string;
  } = {}
): string {
  const { maxItems = 3, emptyMessage = 'None available', prefix = '' } = options;

  if (items.length === 0) {
    return emptyMessage;
  }

  const displayed = items.slice(0, maxItems);
  const remaining = items.length - displayed.length;
  
  let summary = prefix + displayed.map(formatter).join(', ');
  if (remaining > 0) {
    summary += ` (+${remaining} more)`;
  }
  
  return summary;
}

/**
 * Inject context into a tool description
 */
export function injectContext(
  baseDescription: string,
  context: ContextNode | undefined,
  options: { separator?: string } = {}
): string {
  if (!context || context.level === 'collapsed') {
    return baseDescription;
  }

  const { separator = '\n\n' } = options;

  if (context.level === 'summary') {
    return `${baseDescription}${separator}📌 ${context.summary}`;
  }

  // Expanded: include more detail
  return `${baseDescription}${separator}📌 Available (${context.totalCount} total): ${context.summary}`;
}

/**
 * Create a context node with automatic summarization
 */
export function createContextNode<T>(
  items: T[],
  formatter: (item: T) => string,
  options: {
    level?: ContextLevel;
    maxSummaryItems?: number;
    emptyMessage?: string;
    prefix?: string;
  } = {}
): ContextNode<T> {
  const { level = 'summary', maxSummaryItems = 3, emptyMessage, prefix } = options;

  return {
    level,
    summary: buildContextSummary(items, formatter, {
      maxItems: maxSummaryItems,
      emptyMessage,
      prefix,
    }),
    items,
    totalCount: items.length,
    lastUpdated: Date.now(),
  };
}

/**
 * Gallery item context formatter
 */
export interface GalleryContextItem {
  id: string;
  type: 'image' | 'video' | 'sticker';
  prompt?: string;
  url?: string;
}

export function formatGalleryItem(item: GalleryContextItem): string {
  const promptPreview = item.prompt 
    ? ` "${item.prompt.slice(0, 30)}${item.prompt.length > 30 ? '...' : ''}"` 
    : '';
  return `${item.id}${promptPreview}`;
}

/**
 * Build gallery context for send_gallery_image tool
 */
export function buildGalleryContext(
  items: GalleryContextItem[],
  level: ContextLevel = 'summary'
): ContextNode<GalleryContextItem> {
  return createContextNode(items, formatGalleryItem, {
    level,
    maxSummaryItems: 5,
    emptyMessage: 'Gallery is empty - generate some images first!',
    prefix: 'Recent images: ',
  });
}

/**
 * Wallet context formatter
 */
export interface WalletContextItem {
  publicKey: string;
  label?: string;
  solBalance?: number | null;
}

export function formatWalletItem(item: WalletContextItem): string {
  const label = item.label || item.publicKey.slice(0, 8);
  const balance = item.solBalance != null ? ` (${item.solBalance.toFixed(2)} SOL)` : '';
  return `${label}${balance}`;
}

/**
 * Build wallet context
 */
export function buildWalletContext(
  items: WalletContextItem[],
  level: ContextLevel = 'summary'
): ContextNode<WalletContextItem> {
  return createContextNode(items, formatWalletItem, {
    level,
    maxSummaryItems: 3,
    emptyMessage: 'No wallets created yet',
    prefix: 'My wallets: ',
  });
}

/**
 * Channel activity context (for future multi-channel awareness)
 */
export interface ChannelActivityItem {
  channelType: 'telegram' | 'discord' | 'twitter' | 'web';
  channelId: string;
  channelName?: string;
  lastMessageAt: number;
  unreadCount?: number;
}

export function formatChannelActivity(item: ChannelActivityItem): string {
  const name = item.channelName || item.channelId.slice(0, 10);
  const unread = item.unreadCount ? ` (${item.unreadCount} unread)` : '';
  const icon = {
    telegram: '📱',
    discord: '💬',
    twitter: '🐦',
    web: '🌐',
  }[item.channelType];
  return `${icon} ${name}${unread}`;
}

/**
 * Build multi-channel awareness context
 */
export function buildChannelContext(
  items: ChannelActivityItem[],
  level: ContextLevel = 'summary'
): ContextNode<ChannelActivityItem> {
  return createContextNode(items, formatChannelActivity, {
    level,
    maxSummaryItems: 5,
    emptyMessage: 'No active channels',
    prefix: 'Active channels: ',
  });
}

/**
 * Pending jobs context
 */
export interface PendingJobContextItem {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing';
  prompt?: string;
  startedAt: number;
}

export function formatPendingJob(item: PendingJobContextItem): string {
  const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
  return `${item.type} (${elapsed}s ago)`;
}

export function buildPendingJobsContext(
  items: PendingJobContextItem[],
  level: ContextLevel = 'summary'
): ContextNode<PendingJobContextItem> {
  return createContextNode(items, formatPendingJob, {
    level,
    maxSummaryItems: 3,
    emptyMessage: 'No jobs in progress',
    prefix: 'In progress: ',
  });
}
