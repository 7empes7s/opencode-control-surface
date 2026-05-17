export type CompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  model: string;
  messages: CompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
};

export type CompletionChoice = {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
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
