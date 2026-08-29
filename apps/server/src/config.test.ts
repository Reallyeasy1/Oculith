import { describe, expect, it } from "vitest";
import { codexConfigToml, configuredModel, isModelConfigured, loadConfig } from "./config.js";

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
    expect(ark.taskCompletionJudge).toBe("ark");
    expect(codexConfigToml(ark)).toContain(
      'base_url = "https://ark.ap-southeast.bytepluses.com/api/v3"',
    );

    const unset = loadConfig({ NODE_ENV: "test", MODEL_PROVIDER: "openai" });
    expect(isModelConfigured(unset)).toBe(false);
    // #54: an unset ARK_MODEL used to label runs with "" — fall back to the same
    // placeholder codexConfigToml writes, so the UI never shows a blank model.
    expect(configuredModel(ark)).toBe("deepseek-v4-flash-260425");
    expect(configuredModel(loadConfig({ NODE_ENV: "test", ARK_API_KEY: "ark-key" }))).toBe("ep-not-configured");
    expect(configuredModel(unset)).toBe("openai-default");
    expect(configuredModel(openai)).toBe("gpt-test");
    expect(loadConfig({ NODE_ENV: "test", TASK_COMPLETION_JUDGE: "fake" }).taskCompletionJudge).toBe("fake");
    expect(() => loadConfig({ NODE_ENV: "test", TASK_COMPLETION_JUDGE: "other" })).toThrow();
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

describe("GlassBox capture policy config (#259)", () => {
  it("defaults to metadata_only, accepts all three tiers, rejects unknown values", () => {
    expect(loadConfig({ NODE_ENV: "test" }).glassboxCapturePolicy).toBe("metadata_only");
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_CAPTURE_POLICY: "safe_summary" }).glassboxCapturePolicy).toBe("safe_summary");
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_CAPTURE_POLICY: "reasoning_summary" }).glassboxCapturePolicy).toBe("reasoning_summary");
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_CAPTURE_POLICY: "full" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_CAPTURE_POLICY: "raw" })).toThrow();
  });
});

describe("GlassBox cost display config", () => {
  it("keeps pricing optional and accepts non-negative per-million token rates", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({ glassboxPricePerMtokInput: undefined, glassboxPricePerMtokCachedInput: undefined, glassboxPricePerMtokOutput: undefined });
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_INPUT: "2.5", GLASSBOX_PRICE_PER_MTOK_OUTPUT: "0" }))
      .toMatchObject({ glassboxPricePerMtokInput: 2.5, glassboxPricePerMtokCachedInput: 2.5, glassboxPricePerMtokOutput: 0 });
    expect(loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_INPUT: "2.5", GLASSBOX_PRICE_PER_MTOK_CACHED_INPUT: "0.5" }))
      .toMatchObject({ glassboxPricePerMtokInput: 2.5, glassboxPricePerMtokCachedInput: 0.5 });
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_INPUT: "-1" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", GLASSBOX_PRICE_PER_MTOK_CACHED_INPUT: "-1" })).toThrow();
  });
});

describe("Workspace preview config (#96)", () => {
  it("defaults to ports 5180-5189 and a 30 minute TTL", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      previewPortStart: 5180,
      previewPortEnd: 5189,
      previewTtlMs: 1_800_000,
    });
  });
  it("accepts a custom range and TTL, rejects malformed or reversed ranges and tiny TTLs", () => {
    expect(loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "6000-6004", PREVIEW_TTL_MS: "60000" }))
      .toMatchObject({ previewPortStart: 6000, previewPortEnd: 6004, previewTtlMs: 60_000 });
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "6004-6000" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "80" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "abc-def" })).toThrow();
    // Privileged or out-of-range ports and absurdly wide ranges are refused.
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "80-90" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "5000-70000" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_PORT_RANGE: "1025-65535" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", PREVIEW_TTL_MS: "500" })).toThrow();
  });
});
