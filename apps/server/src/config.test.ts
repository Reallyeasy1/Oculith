import { describe, expect, it } from "vitest";
import { codexConfigToml, isModelConfigured, loadConfig } from "./config.js";

describe("Model provider config", () => {
  it("writes an OpenAI provider block and gates readiness on the right key", () => {
    const openai = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
    });
    expect(isModelConfigured(openai)).toBe(true);
    const toml = codexConfigToml(openai);
    expect(toml).toContain('model_provider = "openai_api"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('model = "gpt-test"');
    expect(toml).not.toContain("volcengine_ark");
    expect(toml).not.toContain("sk-test");

    const ark = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "ark-key",
      ARK_MODEL: "deepseek-v4-flash-260425",
      ARK_BASE_URL: "https://ark.ap-southeast.bytepluses.com/api/v3",
      OPENAI_API_KEY: "sk-ignored",
    });
    expect(isModelConfigured(ark)).toBe(true);
    expect(codexConfigToml(ark)).toContain(
      'base_url = "https://ark.ap-southeast.bytepluses.com/api/v3"',
    );

    const unset = loadConfig({ NODE_ENV: "test", MODEL_PROVIDER: "openai" });
    expect(isModelConfigured(unset)).toBe(false);
  });
});
