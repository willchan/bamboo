import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  agentEnvPath,
  envFilePath,
  loadEnvFile,
  geminiKeyChoice,
  geminiKeyLog,
  readConfig,
  readGeminiKeys,
  selectGeminiKey,
} from "./config";

const SECRET = "s3cret-value-never-logged";

describe("readConfig", () => {
  it("uses DESIGN §8.1's defaults for everything but the URL and token", () => {
    expect(
      readConfig({ BAMBOO_API_URL: "https://bamboo.test/", WORKER_API_TOKEN: SECRET }),
    ).toEqual({
      apiUrl: "https://bamboo.test",
      token: SECRET,
      ollamaUrl: "http://localhost:11434",
      model: "qwen3.8:27b",
      pollIntervalMs: 15_000,
      gemini: {
        model: "gemini-3.8-flash",
        free: { requestsPerMinute: 5, requestsPerDay: 20 },
        paid: { requestsPerMinute: 60, requestsPerDay: 2000 },
      },
      namesDenyPath: expect.stringMatching(/\.config\/bamboo\/names\.deny$/u),
    });
  });

  it("takes overrides", () => {
    const c = readConfig({
      BAMBOO_API_URL: "https://bamboo.test",
      WORKER_API_TOKEN: SECRET,
      OLLAMA_URL: "http://127.0.0.1:11434/",
      OLLAMA_TEXT_MODEL: "qwen3.5:4b",
      POLL_INTERVAL_SECONDS: "2.5",
    });
    expect(c).toMatchObject({ ollamaUrl: "http://127.0.0.1:11434", model: "qwen3.5:4b" });
    expect(c.pollIntervalMs).toBe(2500);
  });

  it("names every problem, never a value", () => {
    const bad = () =>
      readConfig({ BAMBOO_API_URL: "bamboo.test", OLLAMA_URL: SECRET, POLL_INTERVAL_SECONDS: "0" });
    expect(bad).toThrow(ConfigError);
    try {
      bad();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("BAMBOO_API_URL is not an http(s) URL");
      expect(m).toContain("WORKER_API_TOKEN is not set");
      expect(m).toContain("OLLAMA_URL");
      expect(m).toContain("POLL_INTERVAL_SECONDS");
      expect(m).not.toContain(SECRET);
    }
    expect(() => readConfig({ WORKER_API_TOKEN: " " })).toThrow(/BAMBOO_API_URL is not set/u);
  });
});

describe("env file", () => {
  it("defaults to ~/.config/bamboo/worker.env; BAMBOO_WORKER_ENV overrides", () => {
    expect(envFilePath({}, "/Users/openclaw-agent")).toBe(
      "/Users/openclaw-agent/.config/bamboo/worker.env",
    );
    expect(envFilePath({ BAMBOO_WORKER_ENV: "/tmp/w.env" }, "/h")).toBe("/tmp/w.env");
  });

  it("loads the file over the process environment and flags a file others can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-env-"));
    const path = join(dir, "worker.env");
    writeFileSync(
      path,
      `# comment\nBAMBOO_API_URL=https://bamboo.test\nWORKER_API_TOKEN=${SECRET}\nOLLAMA_TEXT_MODEL=\n`,
    );
    chmodSync(path, 0o600);
    const env: Record<string, string | undefined> = { POLL_INTERVAL_SECONDS: "30" };
    const s = loadEnvFile(path, env);
    expect(s).toMatchObject({ loaded: true, tooOpen: false });
    expect(s.keys.sort()).toEqual(["BAMBOO_API_URL", "OLLAMA_TEXT_MODEL", "WORKER_API_TOKEN"]);
    expect(env.WORKER_API_TOKEN).toBe(SECRET);
    // A key the file doesn't list still comes from the environment.
    expect(env.POLL_INTERVAL_SECONDS).toBe("30");
    // An empty value in the file means "use the default".
    expect(readConfig(env).model).toBe("qwen3.8:27b");

    chmodSync(path, 0o644);
    expect(loadEnvFile(path, {}).tooOpen).toBe(true);
    expect(loadEnvFile(join(dir, "missing.env"), {})).toMatchObject({ loaded: false, keys: [] });
  });

  // Regression (DESIGN §10 #44): a shell or launchd job that inherits another app's generic
  // WORKER_API_TOKEN, OLLAMA_URL or model must not override Bamboo's own file.
  it("worker.env wins over inherited generic variables, including an empty value", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-env-"));
    const path = join(dir, "worker.env");
    writeFileSync(
      path,
      [
        "BAMBOO_API_URL=https://bamboo.test",
        `WORKER_API_TOKEN=${SECRET}`,
        "OLLAMA_URL=http://localhost:11434",
        "OLLAMA_TEXT_MODEL=",
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o600);
    const env: Record<string, string | undefined> = {
      WORKER_API_TOKEN: "other-apps-token",
      OLLAMA_URL: "http://other-host:11434",
      OLLAMA_TEXT_MODEL: "other-model",
    };
    loadEnvFile(path, env);
    expect(readConfig(env)).toMatchObject({
      apiUrl: "https://bamboo.test",
      token: SECRET,
      ollamaUrl: "http://localhost:11434",
      model: "qwen3.8:27b",
    });
  });

  it("the example file parses and has every variable the worker reads", () => {
    const env: Record<string, string | undefined> = {};
    const s = loadEnvFile(join(import.meta.dirname, "..", "..", "ops", "worker.env.example"), env);
    expect(s.keys.sort()).toEqual([
      "BAMBOO_API_URL",
      "BAMBOO_NAMES_DENY",
      "GEMINI_MODEL",
      "GEMINI_PAID_RPD",
      "GEMINI_PAID_RPM",
      "GEMINI_RPD",
      "GEMINI_RPM",
      "OLLAMA_TEXT_MODEL",
      "OLLAMA_URL",
      "POLL_INTERVAL_SECONDS",
      "WORKER_API_TOKEN",
    ]);
    // The token is a placeholder, so a fresh copy is refused until Will pastes the real one.
    expect(env.WORKER_API_TOKEN).toBe("");
    expect(env.BAMBOO_API_URL).toBe("https://bamboo-panda.vercel.app");
    // The Gemini key lives in agent.env, never in worker.env.
    expect(s.keys).not.toContain("BAMBOO_GEMINI_API_KEY");
  });
});

describe("Gemini keys (fake keys and synthetic files only)", () => {
  const FREE = "fake-free-key-for-tests";
  const PAID = "fake-paid-key-for-tests";
  const OLD = "fake-old-name-key-for-tests";
  const file = (text: string, mode = 0o600) => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-agent-env-"));
    const p = join(dir, "agent.env");
    writeFileSync(p, text, { mode });
    return p;
  };
  const base = { BAMBOO_API_URL: "https://b.test", WORKER_API_TOKEN: "t" };
  const limits = readConfig(base).gemini;

  it("reads both keys, and only those, from agent.env", () => {
    const p = file(
      `BAMBOO_AGENT_API_TOKEN=other\nBAMBOO_GEMINI_API_KEY_FREE=${FREE}\nBAMBOO_GEMINI_API_KEY_PAID=${PAID}\n`,
    );
    const env: Record<string, string | undefined> = {};
    expect(readGeminiKeys(env, p)).toEqual({
      free: { key: FREE, variable: "BAMBOO_GEMINI_API_KEY_FREE", source: "file" },
      paid: { key: PAID, variable: "BAMBOO_GEMINI_API_KEY_PAID", source: "file" },
      tooOpen: false,
    });
    // Nothing from the file reaches the environment.
    expect(env).toEqual({});
  });

  it("accepts the old name as the free key's alias; the new name wins", () => {
    const old = readGeminiKeys({}, file(`BAMBOO_GEMINI_API_KEY=${OLD}\n`));
    expect(old.free).toEqual({ key: OLD, variable: "BAMBOO_GEMINI_API_KEY", source: "file" });
    expect(old.paid).toBeNull();
    const both = file(`BAMBOO_GEMINI_API_KEY=${OLD}\nBAMBOO_GEMINI_API_KEY_FREE=${FREE}\n`);
    expect(readGeminiKeys({}, both).free?.key).toBe(FREE);
    expect(geminiKeyLog(old, selectGeminiKey(old, "free", limits), "/a.env")).toContain(
      "warning: BAMBOO_GEMINI_API_KEY is deprecated; rename it to BAMBOO_GEMINI_API_KEY_FREE",
    );
  });

  it("the process env wins; absent everywhere is null; an open file is flagged", () => {
    const p = file(`BAMBOO_GEMINI_API_KEY_FREE=${FREE}\n`, 0o644);
    const fromEnv = readGeminiKeys({ BAMBOO_GEMINI_API_KEY_FREE: "fake-env-key" }, p);
    expect(fromEnv.free).toMatchObject({ key: "fake-env-key", source: "env" });
    expect(fromEnv.tooOpen).toBe(false);
    expect(readGeminiKeys({}, p).tooOpen).toBe(true);
    expect(readGeminiKeys({}, "/nonexistent/agent.env")).toEqual({
      free: null,
      paid: null,
      tooOpen: false,
    });
    expect(readGeminiKeys({}, file("BAMBOO_API_URL=https://x\n")).free).toBeNull();
  });

  it("the live worker keeps the free key; --gemini-key=paid selects the paid key and its limits", () => {
    const keys = readGeminiKeys(
      {},
      file(`BAMBOO_GEMINI_API_KEY_FREE=${FREE}\nBAMBOO_GEMINI_API_KEY_PAID=${PAID}\n`),
    );
    const live = selectGeminiKey(keys, geminiKeyChoice([]), limits);
    expect(live).toMatchObject({ choice: "free", key: { key: FREE }, limits: limits.free });
    const backfill = selectGeminiKey(keys, geminiKeyChoice(["--", "--gemini-key=paid"]), limits);
    expect(backfill).toMatchObject({ choice: "paid", key: { key: PAID }, limits: limits.paid });
    expect(geminiKeyChoice(["--gemini-key", "paid"])).toBe("paid");
    expect(geminiKeyChoice(["--gemini-key=free"])).toBe("free");
    expect(() => geminiKeyChoice(["--gemini-key=both"])).toThrow(ConfigError);
    expect(() => geminiKeyChoice(["--paid"])).toThrow(/unknown argument/u);
  });

  it("a paid run without the paid key fails; no free key means ollama only", () => {
    const freeOnly = readGeminiKeys({ BAMBOO_GEMINI_API_KEY_FREE: FREE }, "/nonexistent");
    expect(() => selectGeminiKey(freeOnly, "paid", limits)).toThrow(/BAMBOO_GEMINI_API_KEY_PAID/u);
    const none = readGeminiKeys({ BAMBOO_GEMINI_API_KEY_PAID: PAID }, "/nonexistent");
    expect(selectGeminiKey(none, "free", limits)).toBeNull();
    expect(geminiKeyLog(none, null, "/a.env")).toContain(
      "gemini off: BAMBOO_GEMINI_API_KEY_FREE is not set; extracting on ollama only",
    );
  });

  it("startup log lines name each key's variable, never a value", () => {
    const p = file(`BAMBOO_GEMINI_API_KEY_PAID=${PAID}\n`, 0o640);
    const keys = readGeminiKeys({ BAMBOO_GEMINI_API_KEY_FREE: FREE }, p);
    for (const choice of ["free", "paid"] as const) {
      const lines = geminiKeyLog(keys, selectGeminiKey(keys, choice, limits), p).join("\n");
      expect(lines).toContain("gemini free key: environment variable BAMBOO_GEMINI_API_KEY_FREE");
      expect(lines).toContain(`gemini paid key: BAMBOO_GEMINI_API_KEY_PAID in ${p}`);
      expect(lines).toContain(`using the ${choice} key`);
      expect(lines).toContain("chmod 600");
      expect(lines).not.toContain(FREE);
      expect(lines).not.toContain(PAID);
    }
    expect(geminiKeyLog(keys, selectGeminiKey(keys, "paid", limits), p).at(-1)).toBe(
      "gemini: using the paid key (BAMBOO_GEMINI_API_KEY_PAID), 60/min, 2000/day",
    );
  });

  it("agentEnvPath honours BAMBOO_AGENT_ENV", () => {
    expect(agentEnvPath({ BAMBOO_AGENT_ENV: "/x/agent.env" })).toBe("/x/agent.env");
    expect(agentEnvPath({}, "/home/u")).toBe("/home/u/.config/bamboo/agent.env");
  });

  it("GEMINI_RPM/RPD and GEMINI_PAID_RPM/RPD must be whole numbers", () => {
    const g = readConfig({
      ...base,
      GEMINI_RPM: "10",
      GEMINI_RPD: "500",
      GEMINI_PAID_RPM: "300",
      GEMINI_PAID_RPD: "9000",
    }).gemini;
    expect(g.free).toEqual({ requestsPerMinute: 10, requestsPerDay: 500 });
    expect(g.paid).toEqual({ requestsPerMinute: 300, requestsPerDay: 9000 });
    expect(() => readConfig({ ...base, GEMINI_RPM: "fast" })).toThrow(/GEMINI_RPM/u);
    expect(() => readConfig({ ...base, GEMINI_PAID_RPD: "0" })).toThrow(/GEMINI_PAID_RPD/u);
  });
});
