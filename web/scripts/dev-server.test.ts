// dev-server: the prod-copy server only ever runs on a local file and blanks every secret that
// could reach a real service; the seeded server gets a fresh synthetic database.
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLANKED, prepareDevServer, prodCopyRefusal } from "./dev-server";

let dir: string;
let url: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dev-server-"));
  url = `file:${path.join(dir, "copy.db")}`;
  writeFileSync(path.join(dir, "copy.db"), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const real: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  TURSO_DATABASE_URL: "",
  TURSO_AUTH_TOKEN: "real-token",
  AUTH_GOOGLE_SECRET: "real-google",
  AGENT_API_TOKEN: "real-agent",
  PROD_RO_TURSO_TOKEN: "real-ro",
};

describe("prodCopyRefusal", () => {
  it.each([
    [undefined, /not set/],
    ["libsql://bamboo-org.turso.io", /file: URL/],
    ["https://bamboo-org.turso.io", /file: URL/],
    ["file:/nowhere/prod-copy.db", /make prod-copy/],
  ])("refuses %s", (u, why) => expect(prodCopyRefusal(u)).toMatch(why));

  it("accepts an existing local copy", () => expect(prodCopyRefusal(url)).toBeNull());
});

describe("prepareDevServer('prod-copy')", () => {
  it("refuses a remote TURSO_DATABASE_URL", async () => {
    await expect(
      prepareDevServer("prod-copy", { ...real, TURSO_DATABASE_URL: "libsql://prod.turso.io" }),
    ).rejects.toThrow(/refused: .*file: URL/);
  });

  it("runs on the copy under the dev sign-in with every secret blanked", async () => {
    const { env } = await prepareDevServer("prod-copy", { ...real, TURSO_DATABASE_URL: url });
    expect(env.TURSO_DATABASE_URL).toBe(url);
    expect(env.DEV_AUTH_BYPASS).toBe("1");
    expect(env.NEXT_DIST_DIR).toBe(".next-prod-copy");
    for (const k of BLANKED) expect(env[k], k).toBe("");
  });
});

describe("prepareDevServer('seeded')", () => {
  it("seeds a fresh file with phrases in every state", async () => {
    const file = path.join(dir, "seeded.db");
    const { env } = await prepareDevServer("seeded", real, { db: file, distDir: ".next-x" });
    expect(env.TURSO_DATABASE_URL).toBe(`file:${file}`);
    expect(env.NEXT_DIST_DIR).toBe(".next-x");
    for (const k of BLANKED) expect(env[k], k).toBe("");
    const db = createClient({ url: `file:${file}` });
    const states = await db.execute(
      "SELECT p.status, c.state, count(*) AS n FROM card c JOIN phrase p ON p.id = c.phrase_id GROUP BY 1, 2",
    );
    const has = (status: string, state: number) =>
      states.rows.some((r) => r.status === status && Number(r.state) === state);
    expect(has("queued", 0)).toBe(true); // new
    expect(has("active", 1)).toBe(true); // learning
    expect(has("active", 2)).toBe(true); // review
    const imports = await db.execute("SELECT count(*) AS n FROM import");
    expect(Number(imports.rows[0]!.n)).toBeGreaterThan(0);
    db.close();
  });
});
