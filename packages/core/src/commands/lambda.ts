/**
 * Local Lambda command classes — drop-in replacements for @aws-sdk/client-lambda.
 */
export class InvokeCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
