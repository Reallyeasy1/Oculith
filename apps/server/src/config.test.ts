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

describe("GlassBox retention config", () => {
  it("defaults to 7 days / 200 MB, accepts 0 as disabled, rejects garbage", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.glassboxRetentionDays).toBe(7);
    expect(defaults.glassboxMaxDiskMb).toBe(200);
    const off = loadConfig({ NODE_ENV: "test", GLASSBOX_RETENTION_DAYS: "0", GLASSBOX_MAX_DISK_MB: "0" });
    expect(off.glassboxRetentionDays).toBe(0);
    expect(off.glassboxMaxDiskMb).toBe(0);
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_RETENTION_DAYS: "30", GLASSBOX_MAX_DISK_MB: "1.5" }))
      .toMatchObject({ glassboxRetentionDays: 30, glassboxMaxDiskMb: 1.5 });
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_RETENTION_DAYS: "-1" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_MAX_DISK_MB: "lots" })).toThrow();
  });
  it("treats an empty string as unset (default), not as 0", () => {
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_RETENTION_DAYS: "", GLASSBOX_MAX_DISK_MB: "" }))
      .toMatchObject({ glassboxRetentionDays: 7, glassboxMaxDiskMb: 200 });
  });
});

describe("GlassBox cost display config", () => {
  it("keeps pricing optional and accepts non-negative per-million token rates", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({ glassboxPricePerMtokInput: undefined, glassboxPricePerMtokOutput: undefined });
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_INPUT: "2.5", GLASSBOX_PRICE_PER_MTOK_OUTPUT: "0" }))
      .toMatchObject({ glassboxPricePerMtokInput: 2.5, glassboxPricePerMtokOutput: 0 });
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_INPUT: "-1" })).toThrow();
  });
});
