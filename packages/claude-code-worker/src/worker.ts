/**
 * Claude Code Worker
 *
 * Processes coding tasks from SQS queue using Claude Code CLI.
 * Uses stream-json output format for structured communication.
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from '@swarm/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@swarm/core';

// Get the path to the claude binary in node_modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_BIN = join(__dirname, '..', 'node_modules', '.bin', 'claude');
import type {
  ClaudeCodeQueueMessage,
  ClaudeCodeCallback,
  ClaudeCodeResponseRecord,
} from './types.js';

const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const QUEUE_URL = process.env.CLAUDE_CODE_QUEUE_URL!;
const STATE_TABLE = process.env.STATE_TABLE!;

/**
 * Stream-JSON message types from Claude Code CLI
 */
interface StreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: 'init' | 'progress';
  session_id?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      tool_use?: {
        name: string;
        input: Record<string, unknown>;
      };
    }>;
  };
  result?: {
    success: boolean;
    output?: string;
    error?: string;
  };
}

/**
 * Execute Claude Code CLI with streaming JSON
 */
async function executeClaudeCode(
  task: string,
  options: {
    workingDir: string;
    maxTurns: number;
    sessionId?: string;
    onMessage?: (msg: StreamMessage) => void;
    onNeedsInput?: (question: string) => Promise<string | null>;
  }
): Promise<{ success: boolean; output: string; sessionId?: string; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      '-p', // Print mode (non-interactive)
      '--output-format', 'stream-json',
      '--max-turns', String(options.maxTurns),
    ];

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    // Add the task as the prompt
    args.push(task);

    console.log(`[ClaudeCode] Spawning: ${CLAUDE_BIN} ${args.join(' ')}`);

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: options.workingDir,
      env: {
        ...process.env,
        // Ensure we're in non-interactive mode
        CLAUDE_CODE_NON_INTERACTIVE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let sessionId: string | undefined;
    const outputLines: string[] = [];
    let lastError: string | undefined;

    // Read stdout line by line (NDJSON)
    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as StreamMessage;

        // Capture session ID from init
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          sessionId = msg.session_id;
          console.log(`[ClaudeCode] Session: ${sessionId}`);
        }

        // Capture assistant text output
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              outputLines.push(block.text);
            }
          }
        }

        // Capture final result
        if (msg.type === 'result' && msg.result) {
          if (msg.result.success && msg.result.output) {
            outputLines.push(msg.result.output);
          }
          if (!msg.result.success && msg.result.error) {
            lastError = msg.result.error;
          }
        }

        // Call message handler if provided
        options.onMessage?.(msg);
      } catch {
        // Not JSON, might be raw output
        console.log(`[ClaudeCode] Raw: ${line}`);
      }
    });

    // Capture stderr
    const stderrChunks: string[] = [];
    proc.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    proc.on('close', (code) => {
      const output = outputLines.join('\n');
      const stderr = stderrChunks.join('');

      if (code === 0) {
        resolve({
          success: true,
          output: output || 'Task completed successfully.',
          sessionId,
        });
      } else {
        resolve({
          success: false,
          output,
          sessionId,
          error: lastError || stderr || `Process exited with code ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: '',
        error: `Failed to spawn claude: ${err.message}`,
      });
    });
  });
}

/**
 * Process a Claude Code task
 */
async function processTask(msg: ClaudeCodeQueueMessage): Promise<void> {
  const { jobId, avatarId, task, workingDir, maxTurns, sessionId, callbackQueueUrl } = msg;

  console.log(`[${jobId}] Processing task for avatar ${avatarId}`);

  // Update job status to processing
  await updateJobStatus(avatarId, jobId, 'processing');

  try {
    const result = await executeClaudeCode(task!, {
      workingDir: workingDir || '/workspace',
      maxTurns: maxTurns || 30,
      sessionId,
      onMessage: (streamMsg) => {
        // Log progress
        if (streamMsg.type === 'system' && streamMsg.subtype === 'progress') {
          console.log(`[${jobId}] Progress update`);
        }
      },
    });

    if (result.success) {
      console.log(`[${jobId}] Task completed, output length: ${result.output.length}`);

      // Update job status to completed
      await updateJobStatus(avatarId, jobId, 'completed', {
        result: result.output,
        sessionId: result.sessionId,
      });

      // Send completion callback
      const callback: ClaudeCodeCallback = {
        type: 'claude_code_callback',
        jobId,
        avatarId,
        conversationId: msg.conversationId,
        replyToMessageId: msg.replyToMessageId,
        status: 'completed',
        sessionId: result.sessionId,
        result: result.output,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: callbackQueueUrl,
          MessageBody: JSON.stringify(callback),
        })
      );
    } else {
      console.error(`[${jobId}] Task failed: ${result.error}`);

      // Update job status to failed
      await updateJobStatus(avatarId, jobId, 'failed', { error: result.error });

      // Send error callback
      const callback: ClaudeCodeCallback = {
        type: 'claude_code_callback',
        jobId,
        avatarId,
        conversationId: msg.conversationId,
        replyToMessageId: msg.replyToMessageId,
        status: 'failed',
        error: result.error,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: callbackQueueUrl,
          MessageBody: JSON.stringify(callback),
        })
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${jobId}] Task exception:`, errorMessage);

    // Update job status to failed
    await updateJobStatus(avatarId, jobId, 'failed', { error: errorMessage });

    // Send error callback
    const callback: ClaudeCodeCallback = {
      type: 'claude_code_callback',
      jobId,
      avatarId,
      conversationId: msg.conversationId,
      replyToMessageId: msg.replyToMessageId,
      status: 'failed',
      error: errorMessage,
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: callbackQueueUrl,
        MessageBody: JSON.stringify(callback),
      })
    );
  }
}

/**
 * Update job status in DynamoDB
 */
async function updateJobStatus(
  avatarId: string,
  jobId: string,
  status: string,
  extra?: { result?: string; error?: string; sessionId?: string }
): Promise<void> {
  const updateExpr = ['#status = :status', '#updatedAt = :updatedAt'];
  const exprNames: Record<string, string> = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': Date.now(),
  };

  if (status === 'completed' || status === 'failed') {
    updateExpr.push('#completedAt = :completedAt');
    exprNames['#completedAt'] = 'completedAt';
    exprValues[':completedAt'] = Date.now();
  }

  if (extra?.result) {
    updateExpr.push('#result = :result');
    exprNames['#result'] = 'result';
    exprValues[':result'] = extra.result;
  }

  if (extra?.error) {
    updateExpr.push('#error = :error');
    exprNames['#error'] = 'error';
    exprValues[':error'] = extra.error;
  }

  if (extra?.sessionId) {
    updateExpr.push('#sessionId = :sessionId');
    exprNames['#sessionId'] = 'sessionId';
    exprValues[':sessionId'] = extra.sessionId;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `CLAUDE_CODE#${jobId}`,
      },
      UpdateExpression: `SET ${updateExpr.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );
}

/**
 * Main worker loop
 */
export async function runWorker(): Promise<void> {
  console.log('Claude Code worker starting...');
  console.log(`Queue URL: ${QUEUE_URL}`);
  console.log(`State Table: ${STATE_TABLE}`);

  // Verify claude CLI is available
  try {
    const { execSync } = await import('child_process');
    const version = execSync(`"${CLAUDE_BIN}" --version`, { encoding: 'utf8' }).trim();
    console.log(`Claude Code CLI: ${version}`);
  } catch {
    console.error(`Claude Code CLI not found at ${CLAUDE_BIN}! Make sure @anthropic-ai/claude-code is installed.`);
    process.exit(1);
  }

  while (true) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 600, // 10 min for long tasks
        })
      );

      for (const message of result.Messages || []) {
        try {
          const msg = JSON.parse(message.Body!) as ClaudeCodeQueueMessage;
          console.log(`Received ${msg.type} message for job ${msg.jobId}`);

          if (msg.type === 'task') {
            await processTask(msg);
          } else if (msg.type === 'response' && msg.response) {
            // Store response in DynamoDB for waiting worker to pick up
            await ddb.send(
              new PutCommand({
                TableName: STATE_TABLE,
                Item: {
                  pk: `AVATAR#${msg.avatarId}`,
                  sk: `CLAUDE_CODE_RESPONSE#${msg.jobId}`,
                  response: msg.response,
                  timestamp: Date.now(),
                  ttl: Math.floor(Date.now() / 1000) + 300, // 5 min TTL
                } satisfies ClaudeCodeResponseRecord,
              })
            );
          }

          // Delete message from queue
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle,
            })
          );
        } catch (error) {
          console.error('Error processing message:', error instanceof Error ? error.message : String(error));
          // Message will return to queue after visibility timeout
        }
      }
    } catch (error) {
      console.error('Worker error:', error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
