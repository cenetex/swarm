/**
 * LocalLambdaAdapter — noop Lambda client for local mode.
 */
import { LocalAdapter } from './adapter-base.js';

export class LocalLambdaAdapter extends LocalAdapter {
  protected async dispatch(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name.startsWith('InvokeCommand')) {
      console.warn(`[local] Lambda invoke stubbed: ${input.FunctionName}`);
      return {
        $metadata: { httpStatusCode: 200 },
        StatusCode: 200,
        Payload: Buffer.from(JSON.stringify({ status: 'local-noop' })),
      };
    }
    throw new Error(`lambda-adapter: unsupported command "${name}"`);
  }
}
