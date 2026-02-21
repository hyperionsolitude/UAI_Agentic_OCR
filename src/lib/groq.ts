/**
 * Groq API chat completion (OpenAI-compatible endpoint).
 * Used for AI responses; supports agentic file-edit instructions via system prompt.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const { apiKey, model, messages, temperature = 0.7, maxTokens = 4096 } = options;
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || res.statusText || "Groq API error");
  }
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const choice = data.choices?.[0];
  if (!choice?.message?.content) throw new Error("Empty response from Groq");
  return {
    content: choice.message.content,
    model: data.model,
    usage: data.usage,
  };
}

export interface ChatStreamOptions extends ChatOptions {
  onChunk: (delta: string) => void;
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
}

/** Stream chat completion via SSE; calls onChunk for each content delta and onUsage when available. */
export async function chatStream(options: ChatStreamOptions): Promise<{ content: string; model: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const { apiKey, model, messages, temperature = 0.7, maxTokens = 4096, onChunk, onUsage } = options;
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || res.statusText || "Groq API error");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let content = "";
  let lastModel = model;
  let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            model?: string;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
          };
          if (parsed.model) lastModel = parsed.model;
          if (parsed.usage) {
            lastUsage = { prompt_tokens: parsed.usage.prompt_tokens, completion_tokens: parsed.usage.completion_tokens };
            onUsage?.(lastUsage);
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            content += delta;
            onChunk(delta);
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }
  return { content, model: lastModel, usage: lastUsage };
}

/** Fallback model list when API key is missing or models fetch fails. */
export const FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "llama3-8b-8192",
];

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

/** Fetch available model ids from Groq API. Uses FALLBACK_MODELS on error or missing key. */
export async function fetchModels(apiKey: string): Promise<string[]> {
  if (!apiKey?.trim()) return [...FALLBACK_MODELS];
  try {
    const res = await fetch(GROQ_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (!res.ok) return [...FALLBACK_MODELS];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length === 0) return [...FALLBACK_MODELS];
    return [...new Set(ids)].sort();
  } catch {
    return [...FALLBACK_MODELS];
  }
}
