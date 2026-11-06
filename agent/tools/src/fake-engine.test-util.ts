// A fake State Engine for bamboo-tools tests: the agent routes of DESIGN §3.2 with M3's semantics
// (turn-key dedupe, chunking with `more`, Idempotency-Key, 413 above the body limit), in memory.
import {
  ImportRequest,
  KnownRequest,
  sharedConfig,
  turnKey,
  type ImportKind,
  type Notification,
} from "@bamboo/shared";

export interface FakeImport {
  id: string;
  kind: ImportKind;
  idem: string | null;
  turnsNew: number;
  closed: boolean;
  calls: number;
}

export class FakeEngine {
  readonly token = "test-agent-token";
  readonly keys = new Set<string>();
  readonly imports: FakeImport[] = [];
  readonly calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  notifications: Notification[] = [];
  notified: string[] = [];
  nudgeStatus = 200;
  nudgeText: string | null = null;
  /** Fail the next N calls with this status (to exercise retries). */
  failNext: { status: number; error: string; count: number } | null = null;
  maxBodyBytes: number = sharedConfig.imports.maxBodyBytes;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    this.calls.push({ method, path: url.pathname, body, headers });
    const reply = (status: number, v?: unknown) =>
      new Response(v === undefined ? null : JSON.stringify(v), { status });
    if (headers.get("authorization") !== `Bearer ${this.token}`)
      return reply(401, { error: "unauthorized" });
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      return reply(this.failNext.status, { error: this.failNext.error });
    }
    const p = url.pathname;
    if (method === "POST" && p === "/api/imports/known") {
      const req = KnownRequest.safeParse(body);
      if (!req.success) return reply(400, { error: "invalid_body" });
      return reply(200, {
        unknown: [...new Set(req.data.turn_keys)].filter((k) => !this.keys.has(k)),
      });
    }
    if (method === "POST" && p === "/api/imports") {
      if (Buffer.byteLength(raw, "utf8") > this.maxBodyBytes)
        return reply(413, { error: "too_large" });
      const parsed = ImportRequest.safeParse(body);
      if (!parsed.success) return reply(400, { error: "invalid_body" });
      const req = parsed.data;
      const idem = headers.get("idempotency-key");
      let imp = req.import_id
        ? this.imports.find((i) => i.id === req.import_id)
        : this.imports.find((i) => idem !== null && i.idem === idem);
      if (req.import_id && !imp) return reply(404, { error: "not_found" });
      if (!imp) {
        imp = {
          id: `imp${this.imports.length + 1}`,
          kind: req.kind,
          idem,
          turnsNew: 0,
          closed: false,
          calls: 0,
        };
        this.imports.push(imp);
      }
      imp.calls++;
      const fresh = [...new Set(req.turns.map((t) => turnKey(t, imp.kind)))].filter(
        (k) => !this.keys.has(k),
      );
      if (imp.closed && fresh.length) return reply(409, { error: "import_closed" });
      for (const k of fresh) this.keys.add(k);
      imp.turnsNew += fresh.length;
      if (!req.more) imp.closed = true;
      return reply(200, { import_id: imp.id, turns_new: imp.turnsNew, turns_added: fresh.length });
    }
    if (method === "GET" && p === "/api/agent/notifications")
      return reply(200, {
        notifications: this.notifications.filter((n) => !this.notified.includes(n.import_id)),
      });
    const m = /^\/api\/imports\/([^/]+)\/notified$/u.exec(p);
    if (method === "POST" && m) {
      this.notified.push(decodeURIComponent(m[1]!));
      return reply(204);
    }
    if (method === "GET" && p === "/api/agent/nudge")
      return this.nudgeStatus === 200
        ? reply(200, { text: this.nudgeText })
        : reply(this.nudgeStatus, { error: "not_found" });
    return reply(404, { error: "not_found" });
  };
}
