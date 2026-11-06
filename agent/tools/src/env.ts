// Where bamboo-tools finds its settings on the Mac (DESIGN §8.1, §8.3). It runs as the
// `openclaw-agent` user, invoked by OpenClaw, whose gateway env belongs to PandaBase (its own
// AGENT_API_TOKEN lives there). So Bamboo keeps its own files, read here, never the gateway's:
//
//   ~/.config/bamboo/agent.env            BAMBOO_API_URL, AGENT_API_TOKEN (mode 600)
//   ~/.config/bamboo/bamboo.config.json   Discord ids (from agent/bamboo.config.example.json)
//
// Bamboo's own file wins. The process environment is only a fallback, and only for Bamboo's own
// names (BAMBOO_*): a generic name such as AGENT_API_TOKEN is never read from it, because an
// OpenClaw automation inherits the gateway env, where that name holds PandaBase's token. The
// token's env fallback (tests, a one-off shell) is BAMBOO_AGENT_API_TOKEN.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ToolsConfig = z.object({
  discord: z.object({
    /** The `#bamboo` channel: the only one the skill acts in, and where replies go. */
    channel_id: z.string().regex(/^\d+$/u, "a Discord channel id (digits)"),
    /** For message links when one `replies` run answers several imports. */
    guild_id: z.string().regex(/^\d+$/u).nullish(),
  }),
});
export type ToolsConfig = z.infer<typeof ToolsConfig>;

export interface Settings {
  apiUrl: string | null;
  token: string | null;
  /** Where the token came from (a file path and key, or an env name), never its value. */
  tokenSource: string | null;
  /** The agent.env path that was read (or would have been). */
  envFile: string;
  configPath: string;
  /** null when the file is missing; throws when it's present but invalid. */
  config: ToolsConfig | null;
}

export const configDir = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.HOME || homedir(), ".config", "bamboo");

/** `KEY=VALUE` lines; `#` comments and blank lines skipped; optional surrounding quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return out;
}

const readIfExists = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

/** The process-env name for each setting; agent.env uses the key itself. */
export const ENV_NAMES = {
  BAMBOO_API_URL: "BAMBOO_API_URL",
  AGENT_API_TOKEN: "BAMBOO_AGENT_API_TOKEN",
  BAMBOO_CONFIG: "BAMBOO_CONFIG",
} as const;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const dir = configDir(env);
  const envFile = env.BAMBOO_AGENT_ENV || join(dir, "agent.env");
  const fileVars = parseEnvFile(readIfExists(envFile) ?? "");
  /** agent.env first, then the Bamboo-specific env name. */
  const get = (k: keyof typeof ENV_NAMES): { value: string; source: string } | null => {
    if (fileVars[k]) return { value: fileVars[k], source: `${envFile} (${k})` };
    const name = ENV_NAMES[k];
    if (env[name]) return { value: env[name], source: `env ${name}` };
    return null;
  };
  const configPath = get("BAMBOO_CONFIG")?.value ?? join(dir, "bamboo.config.json");
  const raw = readIfExists(configPath);
  let config: ToolsConfig | null = null;
  if (raw !== null) {
    const parsed = ToolsConfig.safeParse(JSON.parse(raw));
    if (!parsed.success)
      throw new Error(`${configPath}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    config = parsed.data;
  }
  const token = get("AGENT_API_TOKEN");
  return {
    apiUrl: get("BAMBOO_API_URL")?.value.replace(/\/+$/u, "") ?? null,
    token: token?.value ?? null,
    tokenSource: token?.source ?? null,
    envFile,
    configPath,
    config,
  };
}
