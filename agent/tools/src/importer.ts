// Upload a conversation's new turns (DESIGN §5.2 *Then, for any source*): compute turn keys →
// `POST /api/imports/known` (≤ 5,000 keys a call) → `POST /api/imports` with only the unknown
// turns, in chunks of ≤ 2 MiB (`more: true` on all but the last), every call carrying
// `Idempotency-Key: discord:<message id>`.
import {
  NOTHING_NEW,
  PUBLIC_LINK_NOTE,
  sharedConfig,
  turnKey,
  type ImportKind,
  type ImportRequest,
  type ImportTurn,
} from "@bamboo/shared";
import type { Api } from "./api";

export interface Conversation {
  title: string | null;
  turns: { user_text: string; reply_text: string }[];
}

export interface ImportMeta {
  kind: ImportKind;
  sourceRef: string | null;
  channelId: string | null;
  messageId: string | null;
}

export interface ImportOutcome {
  import_id: string;
  turns_total: number;
  turns_new: number;
  conversation_title: string | null;
  /** The skill posts this verbatim as its one-line acknowledgement (DESIGN §5.1). */
  reply: string;
}

export interface UploadLimits {
  maxKnownKeys: number;
  maxBodyBytes: number;
}

const DEFAULT_LIMITS: UploadLimits = {
  maxKnownKeys: sharedConfig.imports.maxKnownKeys,
  maxBodyBytes: sharedConfig.imports.maxBodyBytes,
};

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/**
 * Split the turns into request bodies of at most `maxBytes` (JSON, UTF-8). Every body but the
 * last has `more: true`; the caller adds `import_id` to all but the first. Always at least one
 * body, so an import with nothing new is still recorded (and reports its running `turns_new`
 * when a retried call finds the import its idempotency key created).
 */
export function chunkBodies(
  base: Omit<ImportRequest, "turns" | "more" | "import_id">,
  turns: ImportTurn[],
  maxBytes: number,
): ImportRequest[] {
  // Room for `import_id` and `more` on later chunks.
  const overhead = bytes({ ...base, turns: [], more: true, import_id: "X".repeat(64) });
  const bodies: ImportTurn[][] = [[]];
  let size = overhead;
  for (const t of turns) {
    const n = bytes(t) + 1;
    if (overhead + n > maxBytes)
      throw new Error(`turn ${t.position} alone is over the ${maxBytes}-byte upload limit`);
    if (size + n > maxBytes) {
      bodies.push([]);
      size = overhead;
    }
    bodies.at(-1)!.push(t);
    size += n;
  }
  return bodies.map((chunk, i) => ({ ...base, turns: chunk, more: i < bodies.length - 1 }));
}

/** The skill's immediate reply (DESIGN §5.1). */
export function ackReply(o: Omit<ImportOutcome, "reply">, kind: ImportKind): string {
  if (o.turns_new === 0)
    return kind === "link" ? `${NOTHING_NEW}\n${PUBLIC_LINK_NOTE}` : NOTHING_NEW;
  const what = o.conversation_title ? `*${o.conversation_title}*, ` : "";
  const total = `${o.turns_total} ${o.turns_total === 1 ? "question" : "questions"}`;
  return `📥 Got it: ${what}${total}, ${o.turns_new} new. I'll reply when they're processed.`;
}

export async function uploadConversation(
  api: Api,
  conv: Conversation,
  meta: ImportMeta,
  limits: UploadLimits = DEFAULT_LIMITS,
): Promise<ImportOutcome> {
  // One entry per key, first occurrence wins (the engine does the same).
  const byKey = new Map<string, ImportTurn>();
  conv.turns.forEach((t, position) => {
    const k = turnKey(t, meta.kind);
    if (!byKey.has(k)) byKey.set(k, { user_text: t.user_text, reply_text: t.reply_text, position });
  });
  const keys = [...byKey.keys()];
  const unknown = new Set<string>();
  for (let i = 0; i < keys.length; i += limits.maxKnownKeys) {
    for (const k of await api.known(keys.slice(i, i + limits.maxKnownKeys))) unknown.add(k);
  }
  const fresh = keys.filter((k) => unknown.has(k)).map((k) => byKey.get(k)!);

  const bodies = chunkBodies(
    {
      kind: meta.kind,
      origin: "discord",
      source_ref: meta.sourceRef,
      conversation_title: conv.title,
      discord_channel_id: meta.channelId,
      discord_message_id: meta.messageId,
      turns_total: conv.turns.length,
    },
    fresh,
    limits.maxBodyBytes,
  );
  const idem = meta.messageId ? `discord:${meta.messageId}` : null;
  let importId: string | undefined;
  let turnsNew = 0;
  for (const body of bodies) {
    const res = await api.importChunk(importId ? { ...body, import_id: importId } : body, idem);
    importId = res.import_id;
    turnsNew = res.turns_new;
  }
  const outcome = {
    import_id: importId!,
    turns_total: conv.turns.length,
    turns_new: turnsNew,
    conversation_title: conv.title,
  };
  return { ...outcome, reply: ackReply(outcome, meta.kind) };
}
