export class CloudflareFeatureNotImplementedError extends Error {
  constructor(feature: string, detail: string) {
    super(`${feature} is not implemented for the Cloudflare hosted adapter: ${detail}`);
    this.name = 'CloudflareFeatureNotImplementedError';
  }
}
