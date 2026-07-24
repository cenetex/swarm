/**
 * LocalAdapter — shared base for local-mode AWS service adapters.
 *
 * Extracts the command name and input from the AWS SDK v3 command
 * envelope, then delegates to a dispatch method. Handles the Bun-
 * compiled name mangling by matching on prefix rather than exact name.
 */
export type LocalAdapterResult = Record<string, unknown> & {
  $metadata?: { httpStatusCode?: number };
};

export abstract class LocalAdapter {
  async send(command: unknown): Promise<LocalAdapterResult> {
    const name: string =
      (command as { constructor?: { name?: string } })?.constructor?.name ?? '';
    const input: Record<string, unknown> =
      (command as { input?: Record<string, unknown> })?.input ?? {};
    return this.dispatch(name, input);
  }

  /**
   * Subclasses implement this to route commands by name prefix.
   * Throw on unrecognized commands.
   */
  protected abstract dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<LocalAdapterResult>;
}
