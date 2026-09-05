import {
  detectHostedAction,
  sanitizeHostedAssistantOutput,
  type HostedActionId,
} from '@swarm/core/hosted';

export type HostedAction = HostedActionId;

export const hostedActionLabels: Record<HostedAction, string> = {
  create: 'New companion',
  profile: 'Shape this companion',
  model: 'Connect a model',
  telegram: 'Connect Telegram',
  x: 'Connect X',
  memory: 'Memory',
  schedule: 'Follow up later',
  share: 'Share or restore',
  account: 'Your account',
  help: 'How can I help?',
};

export function hostedActionForMessage(message: string): HostedAction | null {
  return detectHostedAction(message);
}

export function cleanHostedReply(content: string): string {
  return sanitizeHostedAssistantOutput(content);
}
