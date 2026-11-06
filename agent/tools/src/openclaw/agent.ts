// The dedicated `bamboo` OpenClaw agent (DESIGN §5.1, §10 #50): its workspace AGENTS.md, made from
// the skill, and its Discord binding, merged into OpenClaw's `bindings` without touching anyone
// else's. Pure functions; agent/install.sh and agent/check.sh call them through ./main.ts.

/** The agent's id in OpenClaw (`agents.entries.<id>`, `bindings[].agentId`). */
export const AGENT_ID = "bamboo";
/** The agent every other message keeps going to (`agents.defaults.systemAgent.agentId`). */
export const SYSTEM_AGENT_ID = "main";
/** The Discord account OpenClaw's bot runs as. */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * The first lines of the workspace AGENTS.md. With thinking off, the model doesn't open SKILL.md
 * on its own, so the instructions are inline and the header says so.
 */
export const AGENTS_MD_HEADER = [
  "# Bamboo agent",
  "",
  "You only handle the #bamboo Discord channel. Follow these instructions exactly; they are " +
    "complete, so you don't need to open any skill file.",
].join("\n");

/** SKILL.md without its `---` frontmatter. Throws if there is none (not a skill file). */
export function skillBody(skill: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(skill);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  return skill.slice(m[0].length);
}

/** The workspace AGENTS.md: the header, then the skill's body, unchanged. */
export function renderAgentsMd(skill: string): string {
  const body = skillBody(skill).trim();
  if (!body) throw new Error("SKILL.md has an empty body");
  return `${AGENTS_MD_HEADER}\n\n${body}\n`;
}

export interface Binding {
  agentId?: unknown;
  match?: {
    channel?: unknown;
    accountId?: unknown;
    peer?: { kind?: unknown; id?: unknown } | null;
  } | null;
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const peerOf = (b: Binding) => (isObject(b.match) && isObject(b.match.peer) ? b.match.peer : null);
const isDiscord = (b: Binding) => isObject(b.match) && b.match.channel === "discord";
/** A binding for exactly this Discord channel (whatever agent it routes to). */
const isChannelBinding = (b: Binding, channelId: string) =>
  isDiscord(b) && peerOf(b)?.kind === "channel" && peerOf(b)?.id === channelId;

export function bambooBinding(channelId: string, accountId = DEFAULT_ACCOUNT_ID): Binding {
  return {
    agentId: AGENT_ID,
    match: { channel: "discord", accountId, peer: { kind: "channel", id: channelId } },
  };
}

/**
 * `bindings` with #bamboo routed to the bamboo agent, first, so no broader Discord binding (main's
 * `accountId: "*"`) can match it before. Every other binding is kept, in order. Dropped: other
 * bindings for this channel (they would compete with ours) and the bamboo agent's bindings to
 * another Discord channel (a stale #bamboo id). An existing, equivalent binding is kept as it is
 * (extra keys included), so a re-run changes nothing.
 */
export function mergeBindings(
  current: unknown,
  channelId: string,
  accountId = DEFAULT_ACCOUNT_ID,
): Binding[] {
  if (!/^\d+$/u.test(channelId)) throw new Error("channel id must be digits");
  const list = (Array.isArray(current) ? current : []).filter(isObject) as Binding[];
  const ours = list.find(
    (b) =>
      b.agentId === AGENT_ID &&
      isChannelBinding(b, channelId) &&
      isObject(b.match) &&
      b.match.accountId === accountId,
  );
  const rest = list.filter(
    (b) =>
      !isChannelBinding(b, channelId) &&
      !(b.agentId === AGENT_ID && isDiscord(b) && peerOf(b)?.kind === "channel"),
  );
  return [ours ?? bambooBinding(channelId, accountId), ...rest];
}

/**
 * The agent a message in this Discord channel goes to: the first binding that matches it (Discord,
 * this account or any, this channel or no peer). Conservative: whether OpenClaw takes the first
 * match or the most specific one, ours being first and exact means it wins. null when no binding
 * matches (OpenClaw's default agent).
 */
export function routeFor(
  bindings: unknown,
  channelId: string,
  accountId = DEFAULT_ACCOUNT_ID,
): string | null {
  for (const b of (Array.isArray(bindings) ? bindings : []).filter(isObject) as Binding[]) {
    if (!isDiscord(b) || !isObject(b.match)) continue;
    const acct = b.match.accountId;
    if (acct !== undefined && acct !== "*" && acct !== accountId) continue;
    const peer = peerOf(b);
    if (peer && !(peer.kind === "channel" && peer.id === channelId)) continue;
    return typeof b.agentId === "string" ? b.agentId : null;
  }
  return null;
}
