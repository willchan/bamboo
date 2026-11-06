// `pnpm smoke` against a fake deployment: canned pages and auth responses, and the real machine
// route handlers (on an in-memory DB), so a new route that forgot its token check fails here.
import { createTestDb, type Db } from "@bamboo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as notificationsGET } from "@/app/api/agent/notifications/route";
import { GET as cronGET } from "@/app/api/cron/daily/route";
import { POST as notifiedPOST } from "@/app/api/imports/[id]/notified/route";
import { POST as knownPOST } from "@/app/api/imports/known/route";
import { POST as importsPOST } from "@/app/api/imports/route";
import { POST as claimPOST } from "@/app/api/jobs/claim/route";
import { POST as completePOST } from "@/app/api/jobs/complete/route";
import { POST as heartbeatPOST } from "@/app/api/worker/heartbeat/route";
import { MACHINE_ROUTES, runSmoke, WRONG_TOKEN, type Fetch } from "./smoke";

const BASE = "https://bamboo.example.test";
const CALLBACK = `${BASE}/api/auth/callback/google`;

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  "/api/imports/known": knownPOST,
  "/api/imports": importsPOST,
  "/api/imports/smoke-check/notified": (req) =>
    notifiedPOST(req, { params: Promise.resolve({ id: "smoke-check" }) }),
  "/api/agent/notifications": notificationsGET,
  "/api/jobs/claim": claimPOST,
  "/api/jobs/complete": completePOST,
  "/api/worker/heartbeat": heartbeatPOST,
  "/api/cron/daily": cronGET,
};

interface Site {
  overrides?: Record<string, () => Response>;
}

/** A fake deployment that behaves like production should. */
function fakeSite(site: Site = {}) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    seen.push({ url, init });
    const u = new URL(url);
    const override = site.overrides?.[u.pathname];
    if (override) return override();
    const redirect = (to: string) => new Response(null, { status: 307, headers: { location: to } });
    switch (u.pathname) {
      case "/":
        return redirect(`${BASE}/sign-in`);
      case "/sign-in":
      case "/apple-icon":
      case "/icon/192":
      case "/icon/512":
        return new Response("ok");
      case "/manifest.webmanifest":
        return Response.json({
          display: "standalone",
          icons: [{ src: "/icon/192" }, { src: "/icon/512" }],
        });
      case "/api/auth/providers":
        return Response.json({ google: { id: "google", callbackUrl: CALLBACK } });
      case "/api/auth/csrf":
        return Response.json(
          { csrfToken: "csrf123" },
          { headers: { "set-cookie": "authjs.csrf-token=abc%7Cdef; Path=/; HttpOnly" } },
        );
      case "/api/auth/signin/google": {
        const body = new URLSearchParams(String(init?.body));
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        if (body.get("csrfToken") !== "csrf123" || !cookie.includes("authjs.csrf-token=")) {
          return redirect(`${BASE}/api/auth/signin?error=MissingCSRF`);
        }
        const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        g.searchParams.set("client_id", "123-abc.apps.googleusercontent.com");
        g.searchParams.set("redirect_uri", CALLBACK);
        return redirect(g.toString());
      }
    }
    const handler = handlers[u.pathname];
    if (handler) return handler(new Request(url, init));
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, seen };
}

let db: Db;
const holder = globalThis as unknown as { __bambooDb?: Db };
beforeEach(async () => {
  db = await createTestDb();
  holder.__bambooDb = db;
  vi.stubEnv("AGENT_API_TOKEN", "real-agent");
  vi.stubEnv("WORKER_API_TOKEN", "real-worker");
  vi.stubEnv("CRON_SECRET", "real-cron");
});
afterEach(() => {
  vi.unstubAllEnvs();
  holder.__bambooDb = undefined;
  db.$client.close();
});

describe("runSmoke", () => {
  it("passes a healthy deployment, one line per check, never sending a real token", async () => {
    const { fetchImpl, seen } = fakeSite();
    const lines: string[] = [];
    const results = await runSmoke(`${BASE}/`, fetchImpl, (l) => lines.push(l));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(6 + MACHINE_ROUTES.length);
    expect(lines.at(-1)).toBe(`all ${results.length} checks passed`);
    for (const { init } of seen) {
      const auth = new Headers(init?.headers).get("authorization");
      expect([null, `Bearer ${WRONG_TOKEN}`]).toContain(auth);
      expect(init?.redirect).toBe("manual");
    }
    // Every route the app serves under /api (but auth) is covered.
    expect(MACHINE_ROUTES.map(([, p]) => p).sort()).toEqual(Object.keys(handlers).sort());
  });

  it("fails on a route that lets a request through, a wrong callback, or a missing provider", async () => {
    const { fetchImpl } = fakeSite({
      overrides: {
        "/api/jobs/claim": () => new Response(null, { status: 204 }),
        "/api/auth/providers": () => Response.json({ github: {} }),
        "/": () => new Response("home"),
        "/apple-icon": () => new Response("x", { status: 500 }),
      },
    });
    const lines: string[] = [];
    const results = await runSmoke(BASE, fetchImpl, (l) => lines.push(l));
    const failed = results.filter((r) => !r.ok).map((r) => [r.name, r.detail]);
    expect(failed).toEqual([
      ["/ signed out redirects to /sign-in", "status 200"],
      ["/apple-icon is 200", "status 500"],
      ["auth providers include google with this site's callback", "no google provider"],
      ["POST /api/jobs/claim refuses no token and a wrong token", "no token: status 204"],
    ]);
    expect(lines.at(-1)).toBe(`4 of ${results.length} checks failed`);
  });

  it("flags a route whose token isn't configured (503), and Google redirects that look wrong", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { fetchImpl } = fakeSite({
      overrides: {
        "/api/auth/signin/google": () =>
          new Response(null, {
            status: 302,
            headers: {
              location: `https://accounts.google.com/auth?client_id=x&redirect_uri=${encodeURIComponent("https://other/cb")}`,
            },
          }),
        "/manifest.webmanifest": () => Response.json({ display: "browser", icons: [] }),
      },
    });
    const results = await runSmoke(BASE, fetchImpl, () => {});
    expect(results.filter((r) => !r.ok).map((r) => r.detail)).toEqual([
      "display browser",
      "client_id is not a Google client",
      "no token: status 503",
    ]);
  });

  it("reports a network error as a failed check", async () => {
    const results = await runSmoke(
      BASE,
      async () => {
        throw new Error("ECONNREFUSED");
      },
      () => {},
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0]!.detail).toBe("error: Error: ECONNREFUSED");
  });
});
