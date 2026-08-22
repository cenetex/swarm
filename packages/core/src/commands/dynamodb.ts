/**
 * Local DynamoDB command classes — drop-in replacements for @aws-sdk/lib-dynamodb.
 */
export type AttributeMap = Record<string, any>;
export type DynamoKey = Record<string, any>;

export type GetCommandInput = AttributeMap;
export type PutCommandInput = AttributeMap;
export type QueryCommandInput = AttributeMap;
export type DeleteCommandInput = AttributeMap;
export type UpdateCommandInput = AttributeMap;
export type ScanCommandInput = AttributeMap;
export type BatchWriteCommandInput = AttributeMap;

export interface GetCommandOutput {
  Item?: AttributeMap;
}

export interface PutCommandOutput {
  Attributes?: AttributeMap;
}

export interface QueryCommandOutput {
  Items?: AttributeMap[];
  Count?: number;
  ScannedCount?: number;
  LastEvaluatedKey?: DynamoKey;
}

export interface DeleteCommandOutput {
  Attributes?: AttributeMap;
}

export interface UpdateCommandOutput {
  Attributes?: AttributeMap;
}

export interface ScanCommandOutput {
  Items?: AttributeMap[];
  Count?: number;
  ScannedCount?: number;
  LastEvaluatedKey?: DynamoKey;
}

export type BatchWriteCommandOutput = AttributeMap;
export type TransactWriteCommandOutput = AttributeMap;
export type TransactWriteItemsCommandOutput = AttributeMap;

export class GetCommand {
  readonly commandName = 'GetCommand';
  input: GetCommandInput;
  constructor(input: GetCommandInput) { this.input = input; }
}
export class PutCommand {
  readonly commandName = 'PutCommand';
  input: PutCommandInput;
  constructor(input: PutCommandInput) { this.input = input; }
}
export class QueryCommand {
  readonly commandName = 'QueryCommand';
  input: QueryCommandInput;
  constructor(input: QueryCommandInput) { this.input = input; }
}
export class DeleteCommand {
  readonly commandName = 'DeleteCommand';
  input: DeleteCommandInput;
  constructor(input: DeleteCommandInput) { this.input = input; }
}
export class UpdateCommand {
  readonly commandName = 'UpdateCommand';
  input: UpdateCommandInput;
  constructor(input: UpdateCommandInput) { this.input = input; }
}
export class ScanCommand {
  readonly commandName = 'ScanCommand';
  input: ScanCommandInput;
  constructor(input: ScanCommandInput) { this.input = input; }
}
export class BatchWriteCommand {
  readonly commandName = 'BatchWriteCommand';
  input: BatchWriteCommandInput;
  constructor(input: BatchWriteCommandInput) { this.input = input; }
}
export class TransactWriteCommand {
  readonly commandName = 'TransactWriteCommand';
  input: AttributeMap;
  constructor(input: AttributeMap) { this.input = input; }
}
export class TransactWriteItemsCommand {
  readonly commandName = 'TransactWriteItemsCommand';
  input: AttributeMap;
  constructor(input: AttributeMap) { this.input = input; }
}

/** Stub class for DynamoDBDocumentClient — satisfies type annotations. */
export class DynamoDBDocumentClient {
  static from(_client: unknown, _options?: unknown): DynamoDBDocumentClient {
    return new DynamoDBDocumentClient();
  }
  async send(command: GetCommand): Promise<GetCommandOutput>;
  async send(command: PutCommand): Promise<PutCommandOutput>;
  async send(command: QueryCommand): Promise<QueryCommandOutput>;
  async send(command: DeleteCommand): Promise<DeleteCommandOutput>;
  async send(command: UpdateCommand): Promise<UpdateCommandOutput>;
  async send(command: ScanCommand): Promise<ScanCommandOutput>;
  async send(command: BatchWriteCommand): Promise<BatchWriteCommandOutput>;
  async send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
  async send(command: TransactWriteItemsCommand): Promise<TransactWriteItemsCommandOutput>;
  async send(command: unknown): Promise<any>;
  async send(_command: unknown): Promise<AttributeMap> {
    throw new Error('DynamoDBDocumentClient stub: inject a real client via _setDynamoClient()');
  }
}
