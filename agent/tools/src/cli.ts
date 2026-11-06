// bamboo-tools (DESIGN §5.1, §5.2): the deterministic CLI that OpenClaw's bamboo skill and its
// command automations call. It reads links and PDFs and calls the engine; it never touches the
// database and never calls a model.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sharedConfig, type ImportKind, type Notification } from "@bamboo/shared";
import { Api, ApiCallError, type Fetch } from "./api";
import { loadSettings, type Settings } from "./env";
import { uploadConversation, type Conversation } from "./importer";
import { PdfError, readPdf } from "./pdf";
import { readShareLink, ShareParseError } from "./share";

export const USAGE = `usage: bamboo-tools <command> [options]

  import --url <link> | --file <pdf> | --text-file <txt> [--channel-id <id>] [--message-id <id>]
      Upload a conversation's new turns. Prints JSON {import_id, turns_total, turns_new,
      conversation_title, reply}; the skill posts \`reply\` as it is.
  segment --url <link> | --file <pdf>
      Dry run: parse and print the title, turn count and first/last prompts. No API calls.
  replies
      Replies for finished imports (posted by an OpenClaw command automation), or NO_REPLY.
  nudge
      Today's review reminder, or NO_REPLY.

Settings: ~/.config/bamboo/agent.env (BAMBOO_API_URL, AGENT_API_TOKEN) and
~/.config/bamboo/bamboo.config.json (BAMBOO_CONFIG); see agent/bamboo.config.example.json.`;

/** Every command the skill or an automation may name (checked by the skill test). */
export const COMMANDS = {
  import: ["url", "file", "text-file", "channel-id", "message-id"],
  segment: ["url", "file"],
  replies: [],
  nudge: [],
} as const satisfies Record<string, readonly string[]>;

export const NO_REPLY = "NO_REPLY";

/** Replies the skill posts when an import can't go ahead (DESIGN §5.1, §5.2). */
export const FAILURE_REPLIES = {
  share_parse_failed: "⚠️ Couldn't read that link. Send the PDF instead.",
  pdftotext_missing: "⚠️ I can't read PDFs on the Mac yet. Send the share link instead.",
  pdf_unreadable: "⚠️ Couldn't read that PDF. Send the share link instead.",
  empty:
    "⚠️ I couldn't find any questions in that. Send a Gemini share link, a PDF, or a pasted answer.",
  not_configured: "⚠️ Bamboo isn't set up on the Mac yet; try again later.",
  wrong_channel: "Bamboo only reads conversations shared in #bamboo.",
  api: "⚠️ Couldn't reach Bamboo just now; send it again in a while.",
} as const;

export interface CliResult {
  code: number;
  /** stdout: JSON for `import`, plain text otherwise. */
  out: string;
  /** stderr: diagnostics (never conversation text). */
  err?: string;
}

export interface Deps {
  env: NodeJS.ProcessEnv;
  readShare: (
    url: string,
  ) => Promise<Conversation & { unknownComponents?: Record<string, number> }>;
  readPdf: (file: string) => Promise<Conversation>;
  readText: (file: string) => string;
  fetch?: Fetch;
  retryDelayMs?: number;
}

export const defaultDeps: Deps = {
  env: process.env,
  readShare: (url) => readShareLink(url),
  readPdf: (file) => readPdf(file),
  readText: (file) => readFileSync(file, "utf8"),
};

class UsageError extends Error {}

function parse(command: keyof typeof COMMANDS, args: readonly string[]) {
  const options = Object.fromEntries(
    COMMANDS[command].map((k) => [k, { type: "string" as const }]),
  );
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false })
      .values as Record<string, string | undefined>;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

type SourceFlag = "url" | "file" | "text-file";

function source(v: Record<string, string | undefined>, allowText: boolean) {
  const flags: SourceFlag[] = allowText ? ["url", "file", "text-file"] : ["url", "file"];
  const given = flags.filter((k) => v[k]);
  if (given.length !== 1)
    throw new UsageError(`give exactly one of --url, --file${allowText ? ", --text-file" : ""}`);
  const k = given[0]!;
  return { flag: k, value: v[k]! };
}

const KIND: Record<SourceFlag, ImportKind> = {
  url: "link",
  file: "pdf",
  "text-file": "text",
};

async function readConversation(deps: Deps, flag: SourceFlag, value: string) {
  if (flag === "url") return deps.readShare(value);
  if (flag === "file") return deps.readPdf(value);
  const text = deps.readText(value).trim();
  return { title: null, turns: text ? [{ user_text: "", reply_text: text }] : [] };
}

/** The error code for a failed read, or rethrow. */
function readFailure(e: unknown): keyof typeof FAILURE_REPLIES {
  if (e instanceof ShareParseError) return "share_parse_failed";
  if (e instanceof PdfError) return e.code;
  throw e;
}

const json = (v: unknown) => JSON.stringify(v);

function failure(code: keyof typeof FAILURE_REPLIES, message: string, exit = 1): CliResult {
  return {
    code: exit,
    out: json({ error: code, message, reply: FAILURE_REPLIES[code] }),
    err: `bamboo-tools: ${code}: ${message}`,
  };
}

function api(settings: Settings, deps: Deps): Api | string {
  if (!settings.apiUrl) return "BAMBOO_API_URL is not set (~/.config/bamboo/agent.env)";
  if (!settings.token) return "AGENT_API_TOKEN is not set (~/.config/bamboo/agent.env)";
  return new Api({
    baseUrl: settings.apiUrl,
    token: settings.token,
    fetch: deps.fetch,
    retryDelayMs: deps.retryDelayMs,
  });
}

async function cmdImport(args: readonly string[], deps: Deps): Promise<CliResult> {
  const v = parse("import", args);
  const { flag, value } = source(v, true);
  const settings = loadSettings(deps.env);
  const channelId = v["channel-id"] ?? null;
  if (channelId && settings.config && channelId !== settings.config.discord.channel_id)
    return failure("wrong_channel", `channel ${channelId} is not the configured #bamboo channel`);
  const client = api(settings, deps);
  if (typeof client === "string") return failure("not_configured", client);

  let conv: Conversation & { unknownComponents?: Record<string, number> };
  try {
    conv = await readConversation(deps, flag, value);
  } catch (e) {
    return failure(readFailure(e), (e as Error).message);
  }
  if (conv.turns.length === 0) return failure("empty", "no turns found");

  try {
    const outcome = await uploadConversation(client, conv, {
      kind: KIND[flag],
      sourceRef: flag === "url" ? value.trim() : flag === "file" ? basename(value) : null,
      channelId,
      messageId: v["message-id"] ?? null,
    });
    const unknown = conv.unknownComponents ?? {};
    return {
      code: 0,
      out: json(outcome),
      err: Object.keys(unknown).length ? `unknown_component ${json(unknown)}` : undefined,
    };
  } catch (e) {
    if (e instanceof ApiCallError) return failure("api", e.message);
    throw e;
  }
}

const basename = (p: string) => p.split(/[\\/]/u).pop() ?? p;

function oneLine(s: string, n: number) {
  const t = s.replace(/\s+/gu, " ").trim();
  if (!t) return "(no prompt text: image-only)";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

async function cmdSegment(args: readonly string[], deps: Deps): Promise<CliResult> {
  const v = parse("segment", args);
  const { flag, value } = source(v, false);
  const t0 = performance.now();
  let conv: Conversation & { unknownComponents?: Record<string, number> };
  try {
    conv = await readConversation(deps, flag, value);
  } catch (e) {
    const code = readFailure(e);
    return { code: 1, out: "", err: `bamboo-tools: ${code}: ${(e as Error).message}` };
  }
  const ms = Math.round(performance.now() - t0);
  const { previewPrompts: n, previewChars: chars } = sharedConfig.tools;
  const empty = conv.turns.filter((t) => !t.user_text.trim()).length;
  const lines = [
    `source:  ${KIND[flag]} (${ms} ms)`,
    `title:   ${conv.title ?? "(none)"}`,
    `turns:   ${conv.turns.length}${empty ? ` (${empty} with no prompt text)` : ""}`,
  ];
  const show = (label: string, list: Conversation["turns"], from: number) => {
    lines.push(label);
    list.forEach((t, i) => lines.push(`  ${from + i + 1}. ${oneLine(t.user_text, chars)}`));
  };
  show(`first ${Math.min(n, conv.turns.length)} prompts:`, conv.turns.slice(0, n), 0);
  if (conv.turns.length > n) {
    const start = Math.max(n, conv.turns.length - n);
    show(`last ${conv.turns.length - start} prompts:`, conv.turns.slice(start), start);
  }
  if (conv.unknownComponents && Object.keys(conv.unknownComponents).length)
    lines.push(`unknown components (dropped): ${json(conv.unknownComponents)}`);
  return { code: 0, out: lines.join("\n") };
}

/** One message for an OpenClaw command automation (it posts stdout to `#bamboo`). */
export function repliesText(notes: Notification[], guildId: string | null | undefined): string {
  if (notes.length === 0) return NO_REPLY;
  if (notes.length === 1)
    return `[[reply_to:${notes[0]!.discord_message_id}]] ${notes[0]!.summary}`;
  return notes
    .map((n) => {
      const link =
        guildId && n.discord_channel_id
          ? `https://discord.com/channels/${guildId}/${n.discord_channel_id}/${n.discord_message_id}`
          : null;
      return link ? `${n.summary}\n↪ ${link}` : n.summary;
    })
    .join("\n\n");
}

async function cmdReplies(args: readonly string[], deps: Deps): Promise<CliResult> {
  parse("replies", args);
  const settings = loadSettings(deps.env);
  const client = api(settings, deps);
  if (typeof client === "string") return { code: 1, out: "", err: `bamboo-tools: ${client}` };
  const notes = await client.notifications();
  const text = repliesText(notes, settings.config?.discord.guild_id);
  // Mark before printing: OpenClaw posts stdout after the command exits (as PandaBase does).
  for (const n of notes) await client.markNotified(n.import_id);
  return { code: 0, out: text };
}

async function cmdNudge(args: readonly string[], deps: Deps): Promise<CliResult> {
  parse("nudge", args);
  const client = api(loadSettings(deps.env), deps);
  if (typeof client === "string") return { code: 1, out: "", err: `bamboo-tools: ${client}` };
  try {
    return { code: 0, out: (await client.nudge()) ?? NO_REPLY };
  } catch (e) {
    // The route arrives with M6; until it's deployed, stay quiet rather than post errors.
    if (e instanceof ApiCallError && e.status === 404)
      return { code: 0, out: NO_REPLY, err: "bamboo-tools: nudge route not deployed (404)" };
    throw e;
  }
}

export async function run(argv: readonly string[], deps: Deps = defaultDeps): Promise<CliResult> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help")
    return { code: 0, out: USAGE };
  try {
    switch (command) {
      case "import":
        return await cmdImport(args, deps);
      case "segment":
        return await cmdSegment(args, deps);
      case "replies":
        return await cmdReplies(args, deps);
      case "nudge":
        return await cmdNudge(args, deps);
      default:
        return { code: 2, out: "", err: `bamboo-tools: unknown command '${command}'\n\n${USAGE}` };
    }
  } catch (e) {
    if (e instanceof UsageError)
      return { code: 2, out: "", err: `bamboo-tools ${command}: ${e.message}\n\n${USAGE}` };
    return { code: 1, out: "", err: `bamboo-tools ${command}: ${(e as Error).message}` };
  }
}
