// Discord through OpenClaw's CLI (DESIGN §5.1, §10 #96). `#bamboo` is a forum: every question is
// its own post (a Discord thread), so bamboo-tools needs two things the agent can't give it:
//
// - which forum a post belongs to, for the channel check (the agent only sees the post's id);
// - a way to answer inside a post, for `replies` (an automation's announce goes to one fixed
//   target, and announcing to the forum opens a new post).
//
// Both go through `openclaw message`, which uses the gateway's own Discord connection: Bamboo
// holds no Discord token. Posts already checked are remembered in
// `~/.config/bamboo/posts.json` (ids only), so a follow-up in the same post costs nothing.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sharedConfig } from "@bamboo/shared";
import { z } from "zod";
import { configDir } from "./env";

export interface Discord {
  /** The channel a thread (a forum post) belongs to; null for a channel that isn't a thread. */
  parentOf(channelId: string): Promise<string | null>;
  /** Post `text` in a channel or thread, as a reply to one of its messages. */
  reply(channelId: string, messageId: string, text: string): Promise<void>;
}

const cfg = sharedConfig.tools.discord;

/** The CLI runs from OpenClaw's exec and its automations, whose PATH may lack Homebrew's. */
function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  return { ...env, PATH: path };
}

function openclaw(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      env.BAMBOO_OPENCLAW_BIN || "openclaw",
      args,
      { env: cliEnv(env), timeout: cfg.cliTimeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        // stderr carries OpenClaw's deprecation warnings: never part of the result or the error.
        if (err)
          reject(new Error(`openclaw message ${args[1]} failed (${err.code ?? err.message})`));
        else resolve(stdout);
      },
    );
  });
}

const ChannelInfo = z.object({
  payload: z.object({
    ok: z.literal(true),
    channel: z.object({ id: z.string(), parent_id: z.string().nullish() }),
  }),
});

/** `openclaw message channel info --json` output → the parent id (exported for tests). */
export function parseChannelInfo(stdout: string): string | null {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("openclaw message channel info printed no JSON");
  const parsed = ChannelInfo.safeParse(JSON.parse(stdout.slice(start)));
  if (!parsed.success) throw new Error("openclaw message channel info: unexpected output");
  return parsed.data.payload.channel.parent_id ?? null;
}

export function openclawDiscord(env: NodeJS.ProcessEnv): Discord {
  return {
    async parentOf(channelId) {
      const out = await openclaw(env, [
        "message",
        "channel",
        "info",
        "--channel",
        "discord",
        "--target",
        `channel:${channelId}`,
        "--json",
      ]);
      return parseChannelInfo(out);
    },
    async reply(channelId, messageId, text) {
      await openclaw(env, [
        "message",
        "send",
        "--channel",
        "discord",
        "--target",
        `channel:${channelId}`,
        "--reply-to",
        messageId,
        "--message",
        text,
      ]);
    },
  };
}

const postsPath = (env: NodeJS.ProcessEnv) => join(configDir(env), "posts.json");
const Posts = z.array(z.string());

function readPosts(env: NodeJS.ProcessEnv): string[] {
  try {
    const parsed = Posts.safeParse(JSON.parse(readFileSync(postsPath(env), "utf8")));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function rememberPost(env: NodeJS.ProcessEnv, id: string) {
  const posts = [...readPosts(env).filter((p) => p !== id), id].slice(-cfg.rememberPosts);
  const path = postsPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(posts));
    renameSync(`${path}.tmp`, path);
  } catch {
    // Only a cache: the next message in the post asks Discord again.
  }
}

/**
 * Is `channelId` the forum itself or one of its posts? Posts found are remembered; a lookup that
 * fails throws (the caller says so), so a Discord hiccup never reads as "another channel".
 */
export async function inForum(
  env: NodeJS.ProcessEnv,
  discord: Discord,
  forumId: string,
  channelId: string,
): Promise<boolean> {
  if (channelId === forumId || readPosts(env).includes(channelId)) return true;
  if ((await discord.parentOf(channelId)) !== forumId) return false;
  rememberPost(env, channelId);
  return true;
}
