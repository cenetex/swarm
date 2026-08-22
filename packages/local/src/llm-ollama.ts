/**
 * Ollama LLM fallback for local-first desktop mode.
 *
 * When OpenRouter is unreachable (no API key configured, offline, etc.)
 * the local server can fall back to a locally running Ollama instance.
 *
 * Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint.
 */
const OLLAMA_BASE = "http://localhost:11434";

export interface OllamaModel {
  name: string;
  size: number;
}

/** Preferred chat models in priority order. First one found wins. */
const PREFERRED_MODELS = [
  "llama3.2",
  "llama3.1",
  "llama3",
  "mistral",
  "phi3",
  "gemma2",
  "qwen2.5",
];

/**
 * Check whether Ollama is reachable and has at least one usable chat model.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(OLLAMA_BASE + "/api/tags", { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json() as { models?: OllamaModel[] };
    return (data.models?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Return the best available chat model name, or undefined if none found.
 */
export async function getOllamaModel(): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(OLLAMA_BASE + "/api/tags", { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const data = await res.json() as { models?: OllamaModel[] };
    const names = new Set((data.models ?? []).map((m) => m.name.split(":")[0]));
    for (const preferred of PREFERRED_MODELS) {
      if (names.has(preferred)) return preferred;
    }
    const first = data.models?.[0]?.name;
    return first ? first.split(":")[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Return the Ollama v1 base URL (OpenAI-compatible). */
export function getOllamaEndpoint(): string {
  return OLLAMA_BASE + "/v1";
}
