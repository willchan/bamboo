// `pnpm smoke <url>`: checks a deployed Bamboo with public requests only. It never signs in, sends
// no real token, and follows no redirect into Google. Run it after each deploy.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The machine routes (DESIGN §3.2): each must refuse a missing and a wrong token with 401. */
export const MACHINE_ROUTES: readonly [method: "GET" | "POST", path: string][] = [
  ["POST", "/api/imports/known"],
  ["POST", "/api/imports"],
  ["POST", "/api/imports/smoke-check/notified"],
  ["GET", "/api/agent/notifications"],
  ["GET", "/api/agent/nudge"],
  ["GET", "/api/agent/eval/turns"],
  ["POST", "/api/jobs/claim"],
  ["POST", "/api/jobs/complete"],
  ["POST", "/api/worker/heartbeat"],
  ["GET", "/api/cron/daily"],
];

/** Obviously fake, so a log line showing it can never be mistaken for a leaked token. */
export const WRONG_TOKEN = "smoke-test-not-a-real-token";

class CheckFailed extends Error {}
function expect(cond: unknown, detail: string): asserts cond {
  if (!cond) throw new CheckFailed(detail);
}

/** `name=value` pairs from Set-Cookie headers, for the CSRF round trip. */
function cookieHeader(res: Response): string {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return all
    .map((c) => c.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

export async function runSmoke(
  rawUrl: string,
  fetchImpl: Fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<CheckResult[]> {
  const base = new URL(rawUrl).origin;
  const callback = `${base}/api/auth/callback/google`;
  const get = (path: string, init: RequestInit = {}) =>
    fetchImpl(new URL(path, base).toString(), { redirect: "manual", ...init });

  const results: CheckResult[] = [];
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, ok: true });
      log(`✓ ${name}`);
    } catch (e) {
      const detail = e instanceof CheckFailed ? e.message : `error: ${String(e)}`;
      results.push({ name, ok: false, detail });
      log(`✗ ${name}: ${detail}`);
    }
  }

  await check("/ signed out redirects to /sign-in", async () => {
    const r = await get("/");
    expect(r.status >= 300 && r.status < 400, `status ${r.status}`);
    const loc = r.headers.get("location");
    expect(loc && new URL(loc, base).pathname === "/sign-in", `location ${loc}`);
  });

  await check("/sign-in is 200", async () => {
    const r = await get("/sign-in");
    expect(r.status === 200, `status ${r.status}`);
  });

  await check("manifest is standalone and its icons load", async () => {
    const r = await get("/manifest.webmanifest");
    expect(r.status === 200, `status ${r.status}`);
    const m = (await r.json()) as { display?: string; icons?: { src: string }[] };
    expect(m.display === "standalone", `display ${m.display}`);
    expect(m.icons && m.icons.length > 0, "no icons");
    for (const icon of m.icons) {
      const i = await get(icon.src);
      expect(i.status === 200, `icon ${icon.src}: status ${i.status}`);
    }
  });

  await check("/apple-icon is 200", async () => {
    const r = await get("/apple-icon");
    expect(r.status === 200, `status ${r.status}`);
  });

  await check("auth providers include google with this site's callback", async () => {
    const r = await get("/api/auth/providers");
    expect(r.status === 200, `status ${r.status}`);
    const p = (await r.json()) as Record<string, { callbackUrl?: string }>;
    expect(p.google, "no google provider");
    expect(p.google.callbackUrl === callback, `callbackUrl ${p.google.callbackUrl}`);
  });

  await check("Google sign-in redirects to Google with this client and callback", async () => {
    const csrf = await get("/api/auth/csrf");
    expect(csrf.status === 200, `csrf status ${csrf.status}`);
    const { csrfToken } = (await csrf.json()) as { csrfToken?: string };
    expect(csrfToken, "no csrfToken");
    const r = await get("/api/auth/signin/google", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(csrf),
      },
      body: new URLSearchParams({ csrfToken, callbackUrl: base }).toString(),
    });
    expect(r.status >= 300 && r.status < 400, `status ${r.status}`);
    const loc = new URL(r.headers.get("location") ?? "", base);
    expect(loc.hostname === "accounts.google.com", `redirects to ${loc.hostname}`);
    const clientId = loc.searchParams.get("client_id") ?? "";
    expect(clientId.endsWith(".apps.googleusercontent.com"), "client_id is not a Google client");
    const redirect = loc.searchParams.get("redirect_uri");
    expect(redirect === callback, `redirect_uri ${redirect}`);
  });

  for (const [method, path] of MACHINE_ROUTES) {
    await check(`${method} ${path} refuses no token and a wrong token`, async () => {
      for (const auth of [null, WRONG_TOKEN]) {
        const r = await get(path, {
          method,
          headers: {
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
          },
          body: method === "POST" ? "{}" : undefined,
        });
        expect(r.status === 401, `${auth ? "wrong" : "no"} token: status ${r.status}`);
      }
    });
  }

  const failed = results.filter((r) => !r.ok).length;
  log(
    failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`,
  );
  return results;
}
