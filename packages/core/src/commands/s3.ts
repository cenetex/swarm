import type { Readable } from 'node:stream';

/**
 * Local S3 command classes — drop-in replacements for @aws-sdk/client-s3.
 */
export class PutObjectCommand {
  readonly commandName = 'PutObjectCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class GetObjectCommand {
  readonly commandName = 'GetObjectCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteObjectCommand {
  readonly commandName = 'DeleteObjectCommand';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class ListObjectsV2Command {
  readonly commandName = 'ListObjectsV2Command';
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}

export interface GetObjectCommandOutput {
  ContentType?: string;
  Body?: Readable | {
    transformToString: (encoding?: BufferEncoding) => Promise<string>;
  };
}

export class S3Client {
  constructor(_config?: Record<string, unknown>) {}
  async send(command: PutObjectCommand): Promise<Record<string, any>>;
  async send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  async send(command: DeleteObjectCommand): Promise<Record<string, any>>;
  async send(command: ListObjectsV2Command): Promise<Record<string, any>>;
  async send(command: unknown): Promise<any>;
  async send(_command: unknown): Promise<Record<string, any>> {
    throw new Error('S3Client stub: inject a real client in production runtime');
  }
}
