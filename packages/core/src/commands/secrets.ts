/**
 * Local Secrets Manager command classes.
 */
export type GetSecretValueCommandInput = Record<string, unknown>;
export type CreateSecretCommandInput = Record<string, unknown>;
export type PutSecretValueCommandInput = Record<string, unknown>;
export type DescribeSecretCommandInput = Record<string, unknown>;
export type UpdateSecretCommandInput = Record<string, unknown>;
export type DeleteSecretCommandInput = Record<string, unknown>;
export type RestoreSecretCommandInput = Record<string, unknown>;

export class GetSecretValueCommand {
  readonly commandName = 'GetSecretValueCommand';
  input: GetSecretValueCommandInput;
  constructor(input: GetSecretValueCommandInput) { this.input = input; }
}
export class CreateSecretCommand {
  readonly commandName = 'CreateSecretCommand';
  input: CreateSecretCommandInput;
  constructor(input: CreateSecretCommandInput) { this.input = input; }
}
export class PutSecretValueCommand {
  readonly commandName = 'PutSecretValueCommand';
  input: PutSecretValueCommandInput;
  constructor(input: PutSecretValueCommandInput) { this.input = input; }
}
export class DescribeSecretCommand {
  readonly commandName = 'DescribeSecretCommand';
  input: DescribeSecretCommandInput;
  constructor(input: DescribeSecretCommandInput) { this.input = input; }
}
export class UpdateSecretCommand {
  readonly commandName = 'UpdateSecretCommand';
  input: UpdateSecretCommandInput;
  constructor(input: UpdateSecretCommandInput) { this.input = input; }
}
export class DeleteSecretCommand {
  readonly commandName = 'DeleteSecretCommand';
  input: DeleteSecretCommandInput;
  constructor(input: DeleteSecretCommandInput) { this.input = input; }
}
export class RestoreSecretCommand {
  readonly commandName = 'RestoreSecretCommand';
  input: RestoreSecretCommandInput;
  constructor(input: RestoreSecretCommandInput) { this.input = input; }
}

export interface GetSecretValueCommandOutput {
  SecretString?: string;
  SecretBinary?: Uint8Array;
}

export class SecretsManagerClient {
  constructor(_config?: Record<string, unknown>) {}
  async send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
  async send(command: unknown): Promise<any>;
  async send(_command: unknown): Promise<Record<string, any>> {
    throw new Error('SecretsManagerClient stub: inject a real client in production runtime');
  }
}
