export type HostedAction = 'create' | 'profile' | 'model' | 'telegram' | 'x' | 'share' | 'account' | 'help';

export const hostedActionLabels: Record<HostedAction, string> = {
  create: 'New companion',
  profile: 'Shape this companion',
  model: 'Connect a model',
  telegram: 'Connect Telegram',
  x: 'Connect X',
  share: 'Share or restore',
  account: 'Your account',
  help: 'How can I help?',
};

const actionRequests: Record<string, HostedAction> = {
  '/new': 'create',
  'new companion': 'create',
  'create a companion': 'create',
  '/profile': 'profile',
  'edit companion': 'profile',
  'shape this companion': 'profile',
  '/model': 'model',
  'connect a model': 'model',
  'connect openrouter': 'model',
  '/telegram': 'telegram',
  'connect telegram': 'telegram',
  '/x': 'x',
  'connect x': 'x',
  '/share': 'share',
  'share companion': 'share',
  'restore companion': 'share',
  '/account': 'account',
  'my account': 'account',
  '/help': 'help',
};

// Exact requests keep ordinary conversation with the companion unchanged.
export function hostedActionForMessage(message: string): HostedAction | null {
  return (
    actionRequests[
      message
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/u, '')
    ] ?? null
  );
}

export function cleanHostedReply(content: string): string {
  return content
    .replace(/<\s*(think|thinking|thought|analysis)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, '')
    .replace(/<\s*(?:think|thinking|thought|analysis)\b[\s\S]*$/giu, '')
    .replace(/<\s*\/?\s*(?:think|thinking|thought|analysis)\s*\/?>/giu, '')
    .trim();
}
