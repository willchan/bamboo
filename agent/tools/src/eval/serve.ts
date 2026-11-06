// `bamboo-eval serve`: judge.html over HTTP so Will can open it on his iPhone (over Tailscale), and
// "Save to Mac" writes results.json next to it. Only two paths exist, under a random token printed
// at start: GET <token>/ (the page) and POST <token>/results. Nothing else is served, the key
// included. Binds to 127.0.0.1 unless --host says otherwise.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ResultsFile } from "./types";

const MAX_BODY = 1024 * 1024;

export interface Served {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export async function serveJudge(opts: {
  dir: string;
  host: string;
  port: number;
  runId: string;
  writeResults: (json: string) => void;
  token?: string;
}): Promise<Served> {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const page = join(opts.dir, "judge.html");
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      });
      res.end(body);
    };
    if (req.method === "GET" && (path === `/${token}/` || path === `/${token}/judge.html`)) {
      send(200, "text/html; charset=utf-8", readFileSync(page, "utf8"));
      return;
    }
    if (req.method === "POST" && path === `/${token}/results`) {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = ResultsFile.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          send(400, "text/plain", "not JSON");
          return;
        }
        if (!parsed.success || parsed.data.run_id !== opts.runId) {
          send(400, "text/plain", "not results for this run");
          return;
        }
        opts.writeResults(JSON.stringify(parsed.data, null, 2));
        send(200, "text/plain", "saved");
      });
      return;
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}/${token}/`,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
