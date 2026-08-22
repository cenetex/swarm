/**
 * Lambda-compatible type definitions.
 *
 * Replaces the @types/aws-lambda dependency with locally-defined interfaces
 * that match the shapes actually used across admin-api and handlers.
 *
 * These types describe the AWS Lambda execution environment contract.
 * In local/dev mode, callers are Express routes that satisfy the same
 * structural contract without the npm dependency.
 *
 * Fields not used by this codebase are omitted to keep the definitions lean.
 */

// ── API Gateway (HTTP API / v2 payload format) ──────────────────────────

export interface HttpRequest {
  body?: string | null;
  cookies?: string[];
  headers: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  rawPath: string;
  rawQueryString: string;
  routeKey: string;
  requestContext: {
    http: {
      method: string;
      path: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
    requestId: string;
    timeEpoch: number;
  };
  isBase64Encoded: boolean;
}

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

export type APIGatewayProxyStructuredResultV2 = HttpResponse;

export type HttpHandler = (
  event: HttpRequest,
  context: ExecutionContext,
) => Promise<HttpResponse>;

// ── SQS ─────────────────────────────────────────────────────────────────

export interface MessageBatch {
  Records: MessageRecord[];
}

export interface MessageRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, MessageAttribute>;
  eventSource: string;
  eventSourceARN: string;
  awsRegion: string;
}

export interface MessageAttribute {
  stringValue?: string;
  binaryValue?: string;
  stringListValues?: string[];
  binaryListValues?: string[];
  dataType: string;
}

export interface MessageBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

// ── Lambda ExecutionContext ──────────────────────────────────────────────────────

export interface ExecutionContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: number;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
}

// ── Scheduled Events (CloudWatch Events / EventBridge) ──────────────────

export interface TimerEvent {
  version: string;
  id: string;
  "detail-type": string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: Record<string, unknown>;
}

// ── DynamoDB Streams ────────────────────────────────────────────────────

export interface DataChangeEvent {
  Records: DataChangeRecord[];
}

export interface DataChangeRecord {
  eventID: string;
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  eventSource: string;
  eventSourceARN: string;
  dynamodb?: {
    Keys?: Record<string, DynamoValue>;
    NewImage?: Record<string, DynamoValue>;
    OldImage?: Record<string, DynamoValue>;
    SequenceNumber?: string;
    SizeBytes?: number;
    StreamViewType?: string;
  };
}

export interface DynamoValue {
  S?: string;
  N?: string;
  B?: string;
  SS?: string[];
  NS?: string[];
  BS?: string[];
  M?: Record<string, DynamoValue>;
  L?: DynamoValue[];
  NULL?: boolean;
  BOOL?: boolean;
}

// ── Generic Handler Types ───────────────────────────────────────────────

export type Handler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: ExecutionContext,
) => Promise<TResult>;

export type MessageBatchHandler = Handler<MessageBatch, MessageBatchResponse | void>;

export type TimerHandler = Handler<TimerEvent, void>;
