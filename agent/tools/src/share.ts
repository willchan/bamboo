// Gemini share links (DESIGN §5.2 *Share link*), ported from M0's spike
// (`spikes/share-link/read.mjs`): two plain HTTPS requests, no browser. Resolve the link, then
// call Gemini's `ujx1Bf` batchexecute RPC and flatten each reply's rich markdown.
//
// Everything here is undocumented and can change without notice, so it fails loudly on a missing
// path (`ShareParseError`, reported as `share_parse_failed`: "send the PDF instead") and counts
// components it doesn't know. When it breaks, repair it with the spike's `--dom` reader.
import https from "node:https";
import { sharedConfig } from "@bamboo/shared";

const cfg = sharedConfig.tools;
const RPC_ID = "ujx1Bf"; // "load shared conversation" (observed 2026-11)
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** The link hosts the skill hands over (DESIGN §5.1). */
const SHARE_LINK =
  /^https:\/\/(?:share\.gemini\.google\/[\w-]+|gemini\.google\.com\/share\/[\w-]+|g\.co\/gemini\/share\/[\w-]+)\/?(?:[?#].*)?$/u;

export const isShareLink = (s: string): boolean => SHARE_LINK.test(s.trim());

export class ShareParseError extends Error {
  override name = "ShareParseError";
}

export interface HttpResponse {
  status: number;
  location: string | null;
  text: string;
}
export interface HttpRequestInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}
export type HttpRequest = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/**
 * `node:https` with a big `maxHeaderSize`: Node's `fetch` fails on Google's response headers
 * (`UND_ERR_HEADERS_OVERFLOW`). Doesn't follow redirects; `readShareLink` does.
 */
export const httpsRequest: HttpRequest = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...init.headers },
        maxHeaderSize: cfg.maxHeaderBytes,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const loc = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            location: typeof loc === "string" ? loc : null,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(cfg.requestTimeoutMs, () =>
      req.destroy(new Error(`timeout: ${new URL(url).host}`)),
    );
    if (init.body) req.write(init.body);
    req.end();
  });

export interface ShareTurn {
  /** Will's prompt as typed (line breaks kept); empty for an image-only prompt. */
  user_text: string;
  /** Gemini's reply, flattened (`flattenRich`). */
  reply_text: string;
}

export interface ShareConversation {
  title: string;
  turns: ShareTurn[];
  /** Components dropped because they're not on the known list (telemetry; a format change). */
  unknownComponents: Record<string, number>;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#(\d+);/gu, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gu, "&");

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)="([^"]*)"/gu)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Known components that carry no study content: suggestion chips, follow-ups, media. */
const DROPPED = new Set(["Elicitation", "FollowUp", "Image", "Video", "Carousel"]);

/**
 * Flatten a reply's markdown-with-components to text (DESIGN §5.2 step 5): TextBox → text and
 * subtext lines; Section → its title, then the body; a checklist TemplateWidget → its labels as
 * `- ` lines; chips, follow-ups and media go. Unknown components are dropped and counted.
 */
export function flattenRich(md: string, unknown: Map<string, number> = new Map()): string {
  let s = md.replace(/<ElicitationsGroup\b[^>]*>[\s\S]*?<\/ElicitationsGroup>/gu, "");
  s = s.replace(/<TextBox\b([^>]*?)\/>/gu, (_, a: string) => {
    const { text = "", subtext = "" } = attrs(a);
    return [text, subtext].filter(Boolean).join("\n");
  });
  s = s.replace(
    /<TemplateWidget\b([^>]*?)>([\s\S]*?)<\/TemplateWidget>/gu,
    (_, a: string, body: string) => {
      const fence = /```(?:json)?\n([\s\S]*?)```/u.exec(body);
      try {
        const items: unknown = (JSON.parse(fence?.[1] ?? "") as { items?: unknown }).items;
        if (
          !Array.isArray(items) ||
          !items.every((it) => typeof (it as { label?: unknown })?.label === "string")
        )
          throw new Error("shape");
        const head = attrs(a).header_title;
        return [head, ...items.map((it) => `- ${(it as { label: string }).label}`)]
          .filter(Boolean)
          .join("\n");
      } catch {
        bump(unknown, "TemplateWidget(unparsed)");
        return body;
      }
    },
  );
  s = s.replace(/<Section\b([^>]*?)>/gu, (_, a: string) => attrs(a).title ?? "");
  s = s.replace(/<\/Section>/gu, "");
  s = s.replace(/<\/?([A-Z]\w*)\b[^<>]*?\/?>/gu, (_, name: string) => {
    if (!DROPPED.has(name)) bump(unknown, name);
    return "";
  });
  return s
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Positional access into the RPC payload; `undefined` on any miss. */
function at(v: unknown, ...path: number[]): unknown {
  let cur = v;
  for (const i of path) {
    if (!Array.isArray(cur)) return undefined;
    cur = cur[i];
  }
  return cur;
}

/**
 * Parse a batchexecute response for the share RPC (DESIGN §5.2 steps 3–4). Envelope: `)]}'`, then
 * length-prefixed JSON chunks; the `[["wrb.fr","ujx1Bf","<payload JSON string>",…]]` line holds
 * the conversation. Payload: `[0][1]` turns oldest first, `[0][2][1]` title; per turn
 * `[2][0][0]` prompt, `[3][0][0][1][0]` reply.
 */
export function parseBatchexecute(text: string): ShareConversation {
  const line = text.split("\n").find((l) => l.startsWith('[["wrb.fr"'));
  if (!line) throw new ShareParseError("batchexecute: no wrb.fr frame");
  const frame = at(JSON.parse(line) as unknown, 0);
  const payload = at(frame, 2);
  if (at(frame, 1) !== RPC_ID || typeof payload !== "string")
    throw new ShareParseError("batchexecute: empty payload (deleted or unknown link)");
  const data = JSON.parse(payload) as unknown;
  const rawTurns = at(data, 0, 1);
  if (!Array.isArray(rawTurns)) throw new ShareParseError("payload: no turns at [0][1]");
  const unknown = new Map<string, number>();
  const turns = rawTurns.map((t: unknown, i) => {
    const user = at(t, 2, 0, 0);
    const reply = at(t, 3, 0, 0, 1, 0);
    if (typeof user !== "string" || typeof reply !== "string")
      throw new ShareParseError(`payload: turn ${i} has no text at the expected paths`);
    return {
      user_text: user.replace(/\r\n/gu, "\n").trim(),
      reply_text: flattenRich(reply, unknown),
    };
  });
  const title = at(data, 0, 2, 1);
  if (typeof title !== "string") throw new ShareParseError("payload: no title at [0][2][1]");
  return { title, turns, unknownComponents: Object.fromEntries(unknown) };
}

/** GET with manual redirects (≤ `maxRedirects`); returns the final response and URL. */
async function getFollowing(request: HttpRequest, url: string) {
  let current = url;
  for (let i = 0; i <= cfg.maxRedirects; i++) {
    const res = await request(current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString();
      continue;
    }
    return { ...res, url: current };
  }
  throw new ShareParseError("too many redirects");
}

/** Read a share link: resolve it, then call the share RPC (DESIGN §5.2 steps 1–2). */
export async function readShareLink(
  link: string,
  request: HttpRequest = httpsRequest,
  reqid: () => number = () => 100000 + Math.floor(Math.random() * 900000),
): Promise<ShareConversation> {
  if (!isShareLink(link)) throw new ShareParseError("not a Gemini share link");
  const page = await getFollowing(request, link.trim());
  if (page.status !== 200) throw new ShareParseError(`share page HTTP ${page.status}`);
  const final = new URL(page.url);
  const shareId = /^\/share\/([^/?#]+)/u.exec(final.pathname)?.[1];
  if (!shareId) throw new ShareParseError("redirect did not land on /share/<id>");
  const bl = /"cfb2h":"([^"]+)"/u.exec(page.text)?.[1]; // build label
  const sid = /"FdrFJe":"([^"]+)"/u.exec(page.text)?.[1]; // session id
  const qs = new URLSearchParams({
    rpcids: RPC_ID,
    "source-path": final.pathname,
    hl: "en-US",
    _reqid: String(reqid()),
    rt: "c",
  });
  if (bl) qs.set("bl", bl);
  if (sid) qs.set("f.sid", sid);
  const fReq = JSON.stringify([[[RPC_ID, JSON.stringify([null, shareId, [4]]), null, "generic"]]]);
  const rpc = await request(`https://${final.host}/_/BardChatUi/data/batchexecute?${qs}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-same-domain": "1",
      referer: page.url,
    },
    body: new URLSearchParams({ "f.req": fReq }).toString(),
  });
  if (rpc.status !== 200) throw new ShareParseError(`batchexecute HTTP ${rpc.status}`);
  try {
    return parseBatchexecute(rpc.text);
  } catch (e) {
    if (e instanceof ShareParseError) throw e;
    throw new ShareParseError(`batchexecute: ${(e as Error).message}`);
  }
}
