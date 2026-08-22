import { existsSync, mkdirSync, statSync } from 'fs';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join } from 'path';

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;

const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;

export const DEFAULT_LOCAL_CHAT_MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m';
export const DEFAULT_LOCAL_CHAT_MODEL_FILE = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
export const DEFAULT_LOCAL_CHAT_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';
export const DEFAULT_LOCAL_CHAT_CONTEXT_SIZE = 4096;

const DEFAULT_LOCAL_CHAT_TEMPERATURE = 0.7;
const DEFAULT_LOCAL_CHAT_MAX_TOKENS = 512;
const MAX_TRANSCRIPT_CHARS = 24_000;

export interface LocalLlamaChatOptions {
  modelPath?: string;
  modelUrl?: string;
  modelId?: string;
  contextSize?: number;
}

export interface LocalLlamaChatStatus {
  provider: 'llama.cpp';
  enabled: boolean;
  ready: boolean;
  packageAvailable?: boolean;
  modelExists: boolean;
  modelPath: string;
  modelId: string;
  contextSize: number;
  downloadUrl: string;
  endpoint: string;
  error?: string;
}

export interface LocalChatCompletionMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string; image_url?: unknown }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface LocalChatCompletionRequest {
  model?: string;
  messages?: LocalChatCompletionMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LocalChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LlamaContext {
  getSequence(): unknown;
}

interface LlamaModel {
  createContext(options?: { contextSize?: number }): Promise<LlamaContext>;
  tokenize(input: string): unknown[];
}

interface LlamaChatSessionInstance {
  prompt(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    stopOnAbortSignal?: boolean;
  }): Promise<string>;
  setChatHistory(history: unknown[]): void;
  dispose(options?: { disposeSequence?: boolean }): void;
  model?: LlamaModel;
}

interface LoadedChatRuntime {
  model: LlamaModel;
  context: LlamaContext;
  ChatSessionCtor: new (options: {
    contextSequence: unknown;
    systemPrompt?: string;
    chatWrapper?: 'auto';
    autoDisposeSequence?: boolean;
  }) => LlamaChatSessionInstance;
}

function appSupportDir(): string {
  const home = process.env.HOME ?? '/tmp';
  return join(home, 'Library', 'Application Support', 'Swarm');
}

export function getDefaultLocalChatModelPath(): string {
  return join(appSupportDir(), 'models', 'chat', DEFAULT_LOCAL_CHAT_MODEL_FILE);
}

export function localLlamaChatEnabled(): boolean {
  return process.env.SWARM_LOCAL_CHAT !== '0';
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOptions(options: LocalLlamaChatOptions = {}): Required<LocalLlamaChatOptions> {
  return {
    modelPath:
      options.modelPath ||
      process.env.SWARM_LOCAL_CHAT_MODEL_PATH ||
      getDefaultLocalChatModelPath(),
    modelUrl:
      options.modelUrl ||
      process.env.SWARM_LOCAL_CHAT_MODEL_URL ||
      DEFAULT_LOCAL_CHAT_MODEL_URL,
    modelId:
      options.modelId ||
      process.env.SWARM_LOCAL_CHAT_MODEL_ID ||
      DEFAULT_LOCAL_CHAT_MODEL_ID,
    contextSize:
      options.contextSize ||
      parsePositiveInt(process.env.SWARM_LOCAL_CHAT_CONTEXT_SIZE, DEFAULT_LOCAL_CHAT_CONTEXT_SIZE),
  };
}

async function nodeLlamaCppAvailable(): Promise<boolean> {
  try {
    await dynamicImport('node-llama-cpp');
    return true;
  } catch {
    return false;
  }
}

async function ensureDownloaded(path: string, url: string): Promise<void> {
  if (existsSync(path) && statSync(path).size > 0) return;

  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await rm(tmpPath, { force: true }).catch(() => undefined);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download chat model: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('Downloaded chat model was empty');

  await writeFile(tmpPath, bytes);
  await rename(tmpPath, path);
}

async function fileSha256(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeContent(content: LocalChatCompletionMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (part?.type === 'image_url') return '[image omitted for local text model]';
    return '';
  }).filter(Boolean).join('\n');
}

function buildPromptInput(messages: LocalChatCompletionMessage[]): {
  systemPrompt: string | undefined;
  history: unknown[];
  prompt: string;
  promptText: string;
} {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => normalizeContent(message.content).trim())
    .filter(Boolean)
    .join('\n\n') || undefined;

  const nonSystem = messages.filter((message) => message.role !== 'system');
  const last = nonSystem[nonSystem.length - 1];
  const earlier = last ? nonSystem.slice(0, -1) : nonSystem;
  const history: unknown[] = [];

  for (const message of earlier) {
    const text = normalizeContent(message.content).trim();
    if (!text) continue;
    if (message.role === 'assistant') {
      history.push({ type: 'model', response: [text] });
    } else if (message.role === 'user') {
      history.push({ type: 'user', text });
    } else if (message.role === 'tool') {
      history.push({ type: 'user', text: `Tool result${message.name ? ` (${message.name})` : ''}: ${text}` });
    }
  }

  let prompt = last ? normalizeContent(last.content).trim() : '';
  if (!prompt) prompt = 'Continue.';
  if (last?.role === 'assistant') {
    prompt = `Continue from this assistant draft:\n${prompt}`;
  } else if (last?.role === 'tool') {
    prompt = `Use this tool result to continue:\n${prompt}`;
  }

  const promptText = [
    systemPrompt ? `System:\n${systemPrompt}` : '',
    ...history.map((item) => {
      const record = item as { type?: string; text?: string; response?: string[] };
      if (record.type === 'user') return `User:\n${record.text ?? ''}`;
      if (record.type === 'model') return `Assistant:\n${record.response?.join('') ?? ''}`;
      return '';
    }),
    `User:\n${prompt}`,
  ].filter(Boolean).join('\n\n').slice(-MAX_TRANSCRIPT_CHARS);

  return { systemPrompt, history, prompt, promptText };
}

function estimateTokenCount(model: LlamaModel, text: string): number {
  try {
    return model.tokenize(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export class LocalLlamaChatService {
  readonly provider = 'llama.cpp' as const;
  readonly modelId: string;
  readonly contextSize: number;

  private readonly modelPath: string;
  private readonly modelUrl: string;
  private runtimePromise: Promise<LoadedChatRuntime> | null = null;
  private generationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: LocalLlamaChatOptions = {}) {
    const resolved = resolveOptions(options);
    this.modelPath = resolved.modelPath;
    this.modelUrl = resolved.modelUrl;
    this.modelId = resolved.modelId;
    this.contextSize = resolved.contextSize;
  }

  endpoint(port: number, host = '127.0.0.1'): string {
    return `http://${host}:${port}/v1`;
  }

  async status(checkPackage = false, endpoint = ''): Promise<LocalLlamaChatStatus> {
    const modelExists = existsSync(this.modelPath) && statSync(this.modelPath).size > 0;
    let packageAvailable: boolean | undefined;
    let error: string | undefined;
    if (checkPackage) {
      packageAvailable = await nodeLlamaCppAvailable();
      if (!packageAvailable) error = 'node-llama-cpp is not installed';
    }
    return {
      provider: 'llama.cpp',
      enabled: localLlamaChatEnabled(),
      ready: modelExists && (packageAvailable ?? true),
      ...(packageAvailable !== undefined ? { packageAvailable } : {}),
      modelExists,
      modelPath: this.modelPath,
      modelId: this.modelId,
      contextSize: this.contextSize,
      downloadUrl: this.modelUrl,
      endpoint,
      ...(error ? { error } : {}),
    };
  }

  async prepare(sampleText = 'Say exactly: ready'): Promise<LocalLlamaChatStatus & { sampleResponse?: string }> {
    await ensureDownloaded(this.modelPath, this.modelUrl);
    const response = await this.complete({
      messages: [{ role: 'user', content: sampleText }],
      max_tokens: 16,
      temperature: 0,
    });
    const status = await this.status(true);
    return {
      ...status,
      ready: true,
      sampleResponse: response.choices[0]?.message.content,
    };
  }

  async modelSha256(): Promise<string | undefined> {
    return fileSha256(this.modelPath);
  }

  async complete(request: LocalChatCompletionRequest, signal?: AbortSignal): Promise<LocalChatCompletionResponse> {
    const run = () => this.completeNow(request, signal);
    const result = this.generationQueue.then(run, run);
    this.generationQueue = result.catch(() => undefined);
    return result;
  }

  private async completeNow(request: LocalChatCompletionRequest, signal?: AbortSignal): Promise<LocalChatCompletionResponse> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error('messages must be a non-empty array');
    }

    const runtime = await this.loadRuntime();
    const { systemPrompt, history, prompt, promptText } = buildPromptInput(request.messages);
    const session = new runtime.ChatSessionCtor({
      contextSequence: runtime.context.getSequence(),
      systemPrompt,
      chatWrapper: 'auto',
      autoDisposeSequence: true,
    });

    try {
      if (history.length > 0) session.setChatHistory(history);
      const maxTokens = parsePositiveInt(request.max_tokens, DEFAULT_LOCAL_CHAT_MAX_TOKENS);
      const temperature = typeof request.temperature === 'number'
        ? Math.max(0, Math.min(2, request.temperature))
        : DEFAULT_LOCAL_CHAT_TEMPERATURE;
      const content = (await session.prompt(prompt, {
        maxTokens,
        temperature,
        signal,
        stopOnAbortSignal: true,
      })).trim();

      const promptTokens = estimateTokenCount(runtime.model, promptText);
      const completionTokens = estimateTokenCount(runtime.model, content);
      return {
        id: `chatcmpl-local-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model || this.modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: completionTokens >= maxTokens ? 'length' : 'stop',
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    } finally {
      session.dispose({ disposeSequence: true });
    }
  }

  private async loadRuntime(): Promise<LoadedChatRuntime> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = this.createRuntime();
    return this.runtimePromise;
  }

  private async createRuntime(): Promise<LoadedChatRuntime> {
    await ensureDownloaded(this.modelPath, this.modelUrl);
    const mod = await dynamicImport('node-llama-cpp');
    const getLlama = mod.getLlama as undefined | (() => Promise<{
      loadModel(options: { modelPath: string }): Promise<LlamaModel>;
    }>);
    const ChatSessionCtor = mod.LlamaChatSession as LoadedChatRuntime['ChatSessionCtor'] | undefined;
    if (typeof getLlama !== 'function' || typeof ChatSessionCtor !== 'function') {
      throw new Error('node-llama-cpp does not expose chat runtime APIs');
    }

    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: this.modelPath });
    const context = await model.createContext({ contextSize: this.contextSize });
    return { model, context, ChatSessionCtor };
  }
}

export function createLocalLlamaChatService(options?: LocalLlamaChatOptions): LocalLlamaChatService {
  return new LocalLlamaChatService(options);
}
