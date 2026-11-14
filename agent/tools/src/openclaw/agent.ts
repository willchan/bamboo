// The OpenClaw agent that serves #bamboo (DESIGN §5.1, §10 #69). The host binds it (the Mac's
// runbook, not Bamboo); agent/install.sh and agent/check.sh only read the config, through
// ./main.ts. Pure functions.

/** The Discord account OpenClaw's bot runs as. */
export const DEFAULT_ACCOUNT_ID = "default";

/** SKILL.md without its `---` frontmatter. Throws if there is none (not a skill file). */
export function skillBody(skill: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(skill);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  return skill.slice(m[0].length);
}

/**
 * The skill's instructions as the lines an agent's AGENTS.md must carry to follow them inline:
 * the body's non-blank lines after its title and `Scope:` paragraph (the host writes its own
 * heading and scope for the section). Trailing whitespace is ignored.
 */
export function instructionLines(skill: string): string[] {
  const lines = skillBody(skill).replace(/\r\n/gu, "\n").split("\n");
  const scope = lines.findIndex((l) => l.startsWith("Scope:"));
  if (scope < 0) throw new Error("SKILL.md has no Scope: paragraph");
  let end = scope;
  while (end < lines.length && lines[end]!.trim() !== "") end++;
  const out = lines
    .slice(end)
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (out.length === 0) throw new Error("SKILL.md has no instructions after its Scope: paragraph");
  return out;
}

/** The skill's instruction lines that the AGENTS.md text doesn't have (empty: it's in step). */
export function missingInstructions(skill: string, agentsMd: string): string[] {
  const have = new Set(
    agentsMd
      .replace(/\r\n/gu, "\n")
      .split("\n")
      .map((l) => l.trimEnd()),
  );
  return instructionLines(skill).filter((l) => !have.has(l));
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

/**
 * The agent a message in this Discord channel goes to: the first binding that matches it (Discord,
 * this account or any, this channel or no peer). null when no binding matches (OpenClaw's default
 * agent).
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
