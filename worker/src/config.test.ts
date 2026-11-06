import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, envFilePath, loadEnvFile, readConfig } from "./config";

const SECRET = "s3cret-value-never-logged";

describe("readConfig", () => {
  it("uses DESIGN §8.1's defaults for everything but the URL and token", () => {
    expect(
      readConfig({ BAMBOO_API_URL: "https://bamboo.test/", WORKER_API_TOKEN: SECRET }),
    ).toEqual({
      apiUrl: "https://bamboo.test",
      token: SECRET,
      ollamaUrl: "http://localhost:11434",
      model: "qwen3.5:9b",
      pollIntervalMs: 15_000,
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

  it("loads without overriding the environment and flags a file others can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-env-"));
    const path = join(dir, "worker.env");
    writeFileSync(
      path,
      `# comment\nBAMBOO_API_URL=https://bamboo.test\nWORKER_API_TOKEN=${SECRET}\nOLLAMA_TEXT_MODEL=\n`,
    );
    chmodSync(path, 0o600);
    const env: Record<string, string | undefined> = { BAMBOO_API_URL: "https://override.test" };
    const s = loadEnvFile(path, env);
    expect(s).toMatchObject({ loaded: true, tooOpen: false });
    expect(s.keys.sort()).toEqual(["OLLAMA_TEXT_MODEL", "WORKER_API_TOKEN"]);
    expect(env.BAMBOO_API_URL).toBe("https://override.test");
    expect(env.WORKER_API_TOKEN).toBe(SECRET);
    // An empty value in the file means "use the default".
    expect(readConfig(env).model).toBe("qwen3.5:9b");

    chmodSync(path, 0o644);
    expect(loadEnvFile(path, {}).tooOpen).toBe(true);
    expect(loadEnvFile(join(dir, "missing.env"), {})).toMatchObject({ loaded: false, keys: [] });
  });

  it("the example file parses and has every variable the worker reads", () => {
    const env: Record<string, string | undefined> = {};
    const s = loadEnvFile(join(import.meta.dirname, "..", "..", "ops", "worker.env.example"), env);
    expect(s.keys.sort()).toEqual([
      "BAMBOO_API_URL",
      "OLLAMA_TEXT_MODEL",
      "OLLAMA_URL",
      "POLL_INTERVAL_SECONDS",
      "WORKER_API_TOKEN",
    ]);
    // The token is a placeholder, so a fresh copy is refused until Will pastes the real one.
    expect(env.WORKER_API_TOKEN).toBe("");
    expect(env.BAMBOO_API_URL).toBe("https://bamboo-panda.vercel.app");
  });
});
