/**
 * Avatar Events API - Issues and feedback from DynamoDB (fast)
 */
import { API_BASE } from './apiBase';
import { apiFetch as fetch } from './client';

export type EventType = 'issue' | 'feedback';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'wont_fix';
export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface AvatarIssueEvent {
  id: string;
  type: 'issue';
  timestamp: number;
  avatarId: string;
  platform: string;
  severity: IssueSeverity;
  category: string;
  title: string;
  description: string;
  userMessage?: string;
  context?: {
    toolName?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    reproSteps?: string[];
  };
  status: IssueStatus;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface AvatarFeedbackEvent {
  id: string;
  type: 'feedback';
  timestamp: number;
  avatarId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}

export type AvatarEvent = AvatarIssueEvent | AvatarFeedbackEvent;

export interface AvatarEventsResponse {
  avatarId: string;
  events: AvatarEvent[];
  count: number;
}

export interface EventCountsResponse {
  avatarId: string;
  openIssues: number;
  recentFeedback: {
    positive: number;
    negative: number;
    neutral: number;
  };
}

export interface ListEventsOptions {
  type?: EventType;
  limit?: number;
  since?: number;
  severity?: IssueSeverity;
  sentiment?: FeedbackSentiment;
  status?: IssueStatus;
}

/**
 * Fetch events for an avatar (issues + feedback) from DynamoDB
 */
export async function fetchAvatarEvents(
  avatarId: string,
  options: ListEventsOptions = {}
): Promise<AvatarEventsResponse> {
  const params = new URLSearchParams();

  if (options.type) params.set('type', options.type);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.since) params.set('since', String(options.since));
  if (options.severity) params.set('severity', options.severity);
  if (options.sentiment) params.set('sentiment', options.sentiment);
  if (options.status) params.set('status', options.status);

  const url = `${API_BASE}/avatars/${avatarId}/events${params.toString() ? `?${params}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch event counts for dashboard
 */
export async function fetchEventCounts(avatarId: string): Promise<EventCountsResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/events/counts`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Update an issue's status
 */
export async function updateEventStatus(
  avatarId: string,
  eventId: string,
  status: IssueStatus
): Promise<void> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/events/${eventId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}
