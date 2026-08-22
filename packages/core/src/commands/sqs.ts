/**
 * Local SQS command classes — drop-in replacements for @aws-sdk/client-sqs.
 */
export class SendMessageCommand {
  readonly commandName = 'SendMessageCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class ReceiveMessageCommand {
  readonly commandName = 'ReceiveMessageCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteMessageCommand {
  readonly commandName = 'DeleteMessageCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class GetQueueAttributesCommand {
  readonly commandName = 'GetQueueAttributesCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}

export type SendMessageCommandInput = Record<string, unknown>;

export class SQSClient {
  constructor(_config?: Record<string, unknown>) {}
  async send(command: unknown): Promise<any>;
  async send(_command: unknown): Promise<Record<string, any>> {
    throw new Error('SQSClient stub: inject a real client in production runtime');
  }
}
