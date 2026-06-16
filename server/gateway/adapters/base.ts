export type CompletionMessage = {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string | unknown[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
};

export type CompletionRequest = {
  model: string;
  messages: CompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  stop?: unknown;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  user?: string;
  [key: string]: unknown;
};

export type CompletionChoice = {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: unknown;
    [key: string]: unknown;
  };
  finish_reason: string | null;
};

export type CompletionChunkDelta = {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  [key: string]: unknown;
};

export type CompletionChunkChoice = {
  index: number;
  delta: CompletionChunkDelta;
  finish_reason: string | null;
};

export type CompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: CompletionChunkChoice[];
};

export type CompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage: CompletionUsage;
};

export type ModelInfo = {
  id: string;
  object: "model";
  owned_by: string;
};

export type HealthResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

export interface ProviderAdapter {
  complete(req: CompletionRequest, timeoutMs?: number): Promise<CompletionResponse>;
  models(): Promise<ModelInfo[]>;
  health(model: string, timeoutMs?: number): Promise<HealthResult>;
}
