import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Templates ship with the repo (not runtime state), so the default is repo-relative rather than cwd-relative:
// `npm run dev` runs the server with cwd apps/server. src/ and dist/ sit at the same depth.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  WORKSPACE_TEMPLATES_DIR: z.string().default(path.join(REPO_ROOT, "workspace-templates")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  MODEL_PROVIDER: z.enum(["ark", "openai"]).default("ark"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.ap-southeast.bytepluses.com/api/v3"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GLASSBOX_CAPTURE_POLICY: z.enum(["metadata_only", "safe_summary"]).default("metadata_only"),
  GLASSBOX_DEMO_FAILURE: z.enum(["off", "timeout"]).default("off"),
  GLASSBOX_TRACE_DIR: z.string().optional(),
  // Retention (FR-14): 0 disables a knob. Defaults are conservative for a single-user demo box.
  // `KNOB=` (empty) means unset → default, not 0 (which would silently disable the knob).
  GLASSBOX_RETENTION_DAYS: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().finite().min(0).default(7)),
  GLASSBOX_MAX_DISK_MB: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().finite().min(0).default(200)),
  GLASSBOX_STORE: z.enum(["json", "postgres"]).default("json"),
  DATABASE_URL: z.string().min(1).optional(),
  GLASSBOX_PRICE_PER_MTOK_INPUT: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().finite().nonnegative().optional()),
  GLASSBOX_PRICE_PER_MTOK_OUTPUT: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().finite().nonnegative().optional()),
  /** Keep completed isolated evaluation workspaces for post-check/debugging; the default cleans them up. */
  KEEP_EVAL_WORKSPACES: z.enum(["0", "1"]).default("0"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    workspaceTemplatesDirectory: path.resolve(env.WORKSPACE_TEMPLATES_DIR),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    modelProvider: env.MODEL_PROVIDER,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    openaiApiKey: env.OPENAI_API_KEY?.trim() ?? "",
    openaiModel: env.OPENAI_MODEL?.trim() ?? "",
    nodeEnv: env.NODE_ENV,
    glassboxCapturePolicy: env.GLASSBOX_CAPTURE_POLICY,
    glassboxDemoFailure: env.GLASSBOX_DEMO_FAILURE,
    traceDirectory: path.resolve(
      env.GLASSBOX_TRACE_DIR ?? path.join(env.APP_DATA_DIR, "traces"),
    ),
    glassboxRetentionDays: env.GLASSBOX_RETENTION_DAYS,
    glassboxMaxDiskMb: env.GLASSBOX_MAX_DISK_MB,
    glassboxStore: env.GLASSBOX_STORE,
    databaseUrl: env.DATABASE_URL,
    glassboxPricePerMtokInput: env.GLASSBOX_PRICE_PER_MTOK_INPUT,
    glassboxPricePerMtokOutput: env.GLASSBOX_PRICE_PER_MTOK_OUTPUT,
    keepEvalWorkspaces: env.KEEP_EVAL_WORKSPACES === "1",
  };
}

const isPlaceholder = (value: string) => value.length === 0 || value.includes("replace-");

export function isModelConfigured(config: AppConfig): boolean {
  return config.modelProvider === "openai"
    ? !isPlaceholder(config.openaiApiKey)
    : !isPlaceholder(config.arkApiKey) && !isPlaceholder(config.arkModel);
}

export function codexConfigToml(config: AppConfig): string {
  const header =
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.";
  if (config.modelProvider === "openai") {
    // Explicit env_key provider rather than Codex's built-in "openai": newer Codex
    // versions expect auth.json for the built-in one and ignore OPENAI_API_KEY.
    return [
      header,
      ...(config.openaiModel ? ["model = " + JSON.stringify(config.openaiModel)] : []),
      'model_provider = "openai_api"',
      "",
      "[model_providers.openai_api]",
      'name = "OpenAI"',
      'base_url = "https://api.openai.com/v1"',
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
    ].join("\n");
  }
  return [
    header,
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = codexConfigToml(config);
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
