// The Mac-side Makefile targets (ops/scripts/*.sh) run for real against a temp HOME, with
// `launchctl`, `pnpm` and `git` replaced by stubs that record their calls. Nothing here touches
// the real launchd, ~/.config or the repo's git state.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "ops", "scripts");
const EXAMPLE = readFileSync(join(ROOT, "ops", "worker.env.example"), "utf8");
const TOKEN = "test-token-not-real";

const STUB = (name: string) => `#!/usr/bin/env bash
echo "${name} $*" >> "$STUB_LOG"
state="$STUB_STATE"
case "${name} $1" in
  "launchctl print") [ -f "$state/loaded" ] ;;
  "launchctl bootstrap") touch "$state/loaded" ;;
  "launchctl bootout") rm -f "$state/loaded" ;;
  "git rev-parse") cat "$state/head" ;;
  "git pull") echo bbbbbbbbbbbbbbbb > "$state/head" ;;
esac
`;

let home: string;
let state: string;
let stubLog: string;
let env: NodeJS.ProcessEnv;

const mode = (p: string) => statSync(p).mode & 0o777;
const envFile = () => join(home, ".config", "bamboo", "worker.env");
const plist = () => join(home, "Library", "LaunchAgents", "com.bamboo.worker.plist");
const calls = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n") : []);

function sh(script: string, extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("bash", [join(SCRIPTS, script)], {
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function setToken() {
  writeFileSync(
    envFile(),
    readFileSync(envFile(), "utf8").replace(/^WORKER_API_TOKEN=$/mu, `WORKER_API_TOKEN=${TOKEN}`),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bamboo-home-"));
  state = join(home, ".stub-state");
  const bin = join(home, ".stub-bin");
  mkdirSync(state);
  mkdirSync(bin);
  stubLog = join(home, ".stub-log");
  writeFileSync(join(state, "head"), "aaaaaaaaaaaaaaaa\n");
  for (const name of ["launchctl", "pnpm", "git"]) {
    writeFileSync(join(bin, name), STUB(name));
    chmodSync(join(bin, name), 0o755);
  }
  env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: stubLog,
    STUB_STATE: state,
    NO_COLOR: "1",
  };
});

describe.skipIf(process.platform === "win32")("make worker-install", () => {
  it("first run: creates worker.env (600) from the example, and doesn't load without a token", () => {
    const r = sh("worker-install.sh");
    expect(r.code).toBe(0);
    expect(readFileSync(envFile(), "utf8")).toBe(EXAMPLE);
    expect(mode(envFile())).toBe(0o600);
    expect(mode(join(home, ".config", "bamboo"))).toBe(0o700);
    expect(r.out).toContain("not loading com.bamboo.worker: WORKER_API_TOKEN is empty");
    expect(calls()).toEqual(["pnpm install --frozen-lockfile"]);
    expect(existsSync(plist())).toBe(false);
  });

  it("with a token: renders the plist and bootstraps it; never overwrites or prints worker.env", () => {
    sh("worker-install.sh");
    setToken();
    chmodSync(envFile(), 0o644);
    const before = readFileSync(envFile(), "utf8");
    const r = sh("worker-install.sh", { SKIP_PNPM_INSTALL: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept");
    expect(r.out).not.toContain(TOKEN);
    expect(readFileSync(envFile(), "utf8")).toBe(before);
    expect(mode(envFile())).toBe(0o600);

    const p = readFileSync(plist(), "utf8");
    expect(p).not.toMatch(/@[A-Z_]+@/u);
    expect(p).toContain(`<string>${ROOT}/worker</string>`);
    expect(p).toContain(`<string>${envFile()}</string>`);
    expect(p).toContain(`<string>${home}/Library/Logs/bamboo/worker.log</string>`);
    expect(p).toContain(
      `<string>${execFileSync("bash", ["-c", "command -v node"], { env, encoding: "utf8" }).trim()}</string>`,
    );
    expect(p).not.toContain(TOKEN);
    const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
    expect(calls().at(-1)).toBe(`launchctl bootstrap gui/${uid} ${plist()}`);
  });

  it("is idempotent: an unchanged, loaded worker is kept; KICKSTART=1 restarts it", () => {
    sh("worker-install.sh");
    setToken();
    sh("worker-install.sh");
    const n = calls().length;
    const again = sh("worker-install.sh");
    expect(again.out).toContain("kept com.bamboo.worker (installed, loaded)");
    expect(
      calls()
        .slice(n)
        .filter((c) => !c.startsWith("launchctl print")),
    ).toEqual(["pnpm install --frozen-lockfile"]);
    const kick = sh("worker-install.sh", { KICKSTART: "1", SKIP_PNPM_INSTALL: "1" });
    expect(kick.code).toBe(0);
    expect(calls().at(-1)).toMatch(/^launchctl kickstart -k gui\/\d+\/com\.bamboo\.worker$/u);
  });

  it("reloads (bootout, then bootstrap) when the installed plist differs", () => {
    sh("worker-install.sh");
    setToken();
    sh("worker-install.sh");
    writeFileSync(plist(), "stale");
    const n = calls().length;
    sh("worker-install.sh", { SKIP_PNPM_INSTALL: "1" });
    const changes = calls()
      .slice(n)
      .filter((c) => !c.startsWith("launchctl print"))
      .map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(changes).toEqual(["launchctl bootout", "launchctl bootstrap"]);
    expect(readFileSync(plist(), "utf8")).toContain("com.bamboo.worker");
  });

  it("DRY_RUN=1 changes nothing", () => {
    const r = sh("worker-install.sh", { DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("[dry-run] would create");
    expect(r.out).toContain("[dry-run] pnpm install --frozen-lockfile");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(calls().filter((c) => !c.startsWith("launchctl print"))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("make mac-update / worker-logs", () => {
  it("mac-update pulls, installs, and restarts the worker only when HEAD moved", () => {
    sh("worker-install.sh");
    setToken();
    sh("worker-install.sh");
    const n = calls().length;
    const r = sh("mac-update.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("updated aaaaaaaaaaaa → bbbbbbbbbbbb");
    const did = calls()
      .slice(n)
      .filter((c) => !c.startsWith("launchctl print") && !c.startsWith("git rev-parse"));
    expect(did[0]).toBe("git pull --ff-only");
    expect(did[1]).toBe("pnpm install --frozen-lockfile");
    expect(did[2]).toMatch(/^launchctl kickstart -k /u);
    expect(did).toHaveLength(3);

    const m = calls().length;
    const again = sh("mac-update.sh");
    expect(again.out).toContain("already up to date");
    expect(
      calls()
        .slice(m)
        .some((c) => c.startsWith("launchctl kickstart")),
    ).toBe(false);
  });

  it("worker-logs shows the state and the last heartbeat", () => {
    sh("worker-install.sh");
    setToken();
    sh("worker-install.sh");
    writeFileSync(
      join(home, "Library", "Logs", "bamboo", "worker.log"),
      "2026-11-06T04:00:00Z heartbeat ok (ollama_ok=true)\n2026-11-06T04:01:00Z job j1 attempt 1: done\n",
    );
    const r = sh("worker-logs.sh", { FOLLOW: "0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("com.bamboo.worker: loaded");
    expect(r.out).toContain("last heartbeat: 2026-11-06T04:00:00Z heartbeat ok (ollama_ok=true)");
    expect(r.out).toContain("job j1 attempt 1: done");
  });
});
