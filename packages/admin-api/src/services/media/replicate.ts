export interface ReplicateValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  accountType?: string;
  billingEnabled?: boolean;
}

function summarizeReplicateAccountError(raw: string): string | undefined {
  const text = (raw || '').trim();
  if (!text) return undefined;
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    const detail = typeof obj.detail === 'string' ? obj.detail : undefined;
    const title = typeof obj.title === 'string' ? obj.title : undefined;
    const error = typeof obj.error === 'string' ? obj.error : undefined;
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    const candidate = detail || error || message || title;
    return candidate && candidate.trim() ? candidate.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function validateReplicateApiKey(apiKey: string, deps?: { fetchFn?: typeof fetch }): Promise<ReplicateValidationResult> {
  const fetchFn = deps?.fetchFn ?? fetch;

  try {
    const warnings: string[] = [];
    // Most Replicate API tokens are formatted like "r8_..."; don't block on this.
    if (!/^r8_[A-Za-z0-9]{8,}/.test(apiKey.trim())) {
      warnings.push('Token format looks unusual. If validation fails, double-check you copied the API token from Replicate.');
    }

    const response = await fetchFn('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Token ${apiKey}` },
    });

    const bodyText = await response.text().catch(() => '');

    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key. Please check your Replicate dashboard.' };
    }

    if (response.status === 402) {
      return {
        valid: false,
        error: 'Replicate requires billing to be enabled for API access. Please add a payment method at replicate.com/account/billing.',
      };
    }

    if (response.status === 429) {
      return {
        valid: false,
        error: 'Replicate rate-limited the validation request. Please wait a moment and try again.',
      };
    }

    if (!response.ok) {
      const detail = summarizeReplicateAccountError(bodyText);
      return {
        valid: false,
        error: detail || `Replicate API error: ${response.status} ${response.statusText}`,
      };
    }

    const account = (bodyText
      ? (JSON.parse(bodyText) as unknown)
      : {}) as { type?: string; billing_enabled?: boolean };
    const accountType = account.type || 'unknown';
    const billingEnabled = typeof account.billing_enabled === 'boolean'
      ? account.billing_enabled
      : undefined;

    // IMPORTANT: We only validate that the token is accepted by Replicate.
    // Some accounts/tokens may report billing fields differently (or omit them),
    // and blocking on billing here causes false negatives.
    if (billingEnabled === false) {
      return {
        valid: true,
        warning: [
          ...warnings,
          'Billing appears disabled on this Replicate account. Some models/usage may require a payment method.',
        ].join(' '),
        accountType,
        billingEnabled,
      };
    }

    return {
      valid: true,
      warning: warnings.length > 0 ? warnings.join(' ') : undefined,
      accountType,
      billingEnabled,
    };
  } catch {
    return { valid: false, error: 'Could not validate API key' };
  }
}
