// Where bamboo-tools finds its settings on the Mac (DESIGN §8.1, §8.3). It runs as the
// `openclaw-agent` user, invoked by OpenClaw, which passes its own env file to every app's tools.
// So Bamboo keeps its own files, read here, never the gateway's, and every key it reads carries
// the BAMBOO_ prefix: an unprefixed name could be another app's (PandaBase's AGENT_API_TOKEN):
//
//   ~/.config/bamboo/agent.env            BAMBOO_API_URL, BAMBOO_AGENT_API_TOKEN (mode 600)
//   ~/.config/bamboo/bamboo.config.json   Discord ids (from agent/bamboo.config.example.json)
//
// Variables already in the process environment win over the file.
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

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const dir = configDir(env);
  const envFile = env.BAMBOO_AGENT_ENV || join(dir, "agent.env");
  const fileVars = parseEnvFile(readIfExists(envFile) ?? "");
  const get = (k: string) => env[k] || fileVars[k] || null;
  const configPath = get("BAMBOO_CONFIG") ?? join(dir, "bamboo.config.json");
  const raw = readIfExists(configPath);
  let config: ToolsConfig | null = null;
  if (raw !== null) {
    const parsed = ToolsConfig.safeParse(JSON.parse(raw));
    if (!parsed.success)
      throw new Error(`${configPath}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    config = parsed.data;
  }
  return {
    apiUrl: get("BAMBOO_API_URL")?.replace(/\/+$/u, "") ?? null,
    token: get("BAMBOO_AGENT_API_TOKEN"),
    configPath,
    config,
  };
}
