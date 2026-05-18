import { describe, expect, test } from "bun:test";
import { parseLiteLLMConfig } from "./litellm.ts";

describe("LiteLLM config parsing", () => {
  test("extracts models and fallback chains from config yaml", () => {
    const parsed = parseLiteLLMConfig(`
model_list:
  - model_name: editorial-heavy
    litellm_params:
      model: ollama_chat/gemma4:26b
      api_base: http://localhost:11434
      api_key: os.environ/LOCAL_KEY
      timeout: 600
      stream_timeout: 600
  - model_name: editorial-cloud-heavy
    litellm_params:
      model: openrouter/foo/bar
      api_key: sk-testsecret
      timeout: 60
router_settings:
  fallbacks:
    - editorial-heavy: [editorial-cloud-heavy, groq-llama70b]
`);

    expect(parsed.modelCount).toBe(2);
    expect(parsed.models[0]).toEqual({
      name: "editorial-heavy",
      backendModel: "ollama_chat/gemma4:26b",
      apiBase: "http://localhost:11434",
      provider: "ollama",
      timeoutSeconds: 600,
      hasApiKeyRef: true,
    });
    expect(parsed.fallbacks).toContainEqual({
      model: "editorial-heavy",
      fallbacks: ["editorial-cloud-heavy", "groq-llama70b"],
    });
  });

  test("redacts configured secret fields and inline OpenAI-style keys", () => {
    const parsed = parseLiteLLMConfig(`
litellm_params:
  api_key: os.environ/OPENROUTER_API_KEY
general_settings:
  master_key: sk-1234567890abcdef
`);

    expect(parsed.redactedYaml).toContain("api_key: [redacted]");
    expect(parsed.redactedYaml).toContain("master_key: [redacted]");
    expect(parsed.redactedYaml).not.toContain("OPENROUTER_API_KEY");
    expect(parsed.redactedYaml).not.toContain("sk-1234567890abcdef");
  });
});
