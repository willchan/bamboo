// The PWA's failure handling (DESIGN §6 *Saving*, §8.5): error kinds, report fields, the build
// check and the pending-saves store. All synthetic.
import { describe, expect, it } from "vitest";
import { config } from "../config";
import { checkBuild, reloadForNewBuild } from "./build";
import { classifyError, logEntry, pageOf } from "./client-log";
import { addPending, listPending, removePending, type PendingSave } from "./pending-saves";

const named = (name: string, extra: object = {}) =>
  Object.assign(new Error("message with 辅食"), { name }, extra);

describe("classifyError", () => {
  it("sorts failures into kinds", () => {
    expect(classifyError(named("UnrecognizedActionError"))).toBe("stale");
    expect(classifyError(new TypeError("Load failed"))).toBe("offline");
    expect(classifyError(new Error("x"), false)).toBe("offline");
    expect(classifyError(named("Error", { digest: "123456" }))).toBe("server");
    expect(classifyError(new Error("x"))).toBe("other");
    expect(classifyError(null)).toBe("other");
  });
});

describe("logEntry", () => {
  it("keeps fixed fields only: no message, no ids in the page", () => {
    const e = logEntry(
      { where: "save", err: named("UnrecognizedActionError"), attempts: 1 },
      { pathname: "/review/abc123", online: true, build: "dpl_1" },
    );
    expect(e).toEqual({
      where: "save",
      kind: "stale",
      name: "UnrecognizedActionError",
      attempts: 1,
      build: "dpl_1",
      page: "/review",
      online: true,
    });
    expect(JSON.stringify(e)).not.toContain("辅食");
  });

  it("drops fields that aren't safe tokens and honours an explicit kind", () => {
    const e = logEntry(
      { where: "version", err: { name: "a b", digest: "x y" }, kind: "stale" },
      { pathname: "/", online: false, build: "has space" },
    );
    expect(e).toEqual({
      where: "version",
      kind: "stale",
      build: "unknown",
      page: "/",
      online: false,
    });
  });

  it("reduces a path to its first segment", () => {
    expect(pageOf("/")).toBe("/");
    expect(pageOf("/phrases/xyz")).toBe("/phrases");
    expect(pageOf("/%E8%BE%85")).toBe("/");
  });
});

const res = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

describe("checkBuild", () => {
  it("compares the page's build with the server's", async () => {
    expect(await checkBuild(() => res({ build: "a" }), "a")).toBe("same");
    expect(await checkBuild(() => res({ build: "b" }), "a")).toBe("changed");
    expect(await checkBuild(() => res({}), "a")).toBe("unknown");
    expect(await checkBuild(() => res({ build: "b" }, false), "a")).toBe("unknown");
    expect(await checkBuild(() => Promise.reject(new TypeError("offline")), "a")).toBe("unknown");
  });
});

function memoryStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("reloadForNewBuild", () => {
  it("reloads once per guard window", () => {
    const s = memoryStore();
    let reloads = 0;
    const reload = () => void reloads++;
    expect(reloadForNewBuild(s, 1_000_000, reload)).toBe(true);
    expect(reloadForNewBuild(s, 1_000_000 + config.client.reloadGuardMs - 1, reload)).toBe(false);
    expect(reloadForNewBuild(s, 1_000_000 + config.client.reloadGuardMs, reload)).toBe(true);
    expect(reloads).toBe(2);
  });

  it("doesn't reload when it can't remember having reloaded (no loop)", () => {
    let reloads = 0;
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(reloadForNewBuild(blocked, 0, () => void reloads++)).toBe(false);
    expect(reloadForNewBuild(null, 0, () => void reloads++)).toBe(false);
    expect(reloads).toBe(0);
  });
});

describe("pending saves", () => {
  const grade: PendingSave = {
    kind: "grade",
    id: "r1",
    roundId: "round1",
    cardId: "c1",
    grade: 3,
    alreadyKnow: false,
    durationMs: 1200,
  };
  const drop: PendingSave = { kind: "notUseful", id: "n1", roundId: "round1", cardId: "c2" };

  it("keeps saves until they're confirmed, in order, once each", () => {
    const s = memoryStore();
    addPending(grade, s);
    addPending(drop, s);
    addPending(grade, s); // the same save again: still once
    expect(listPending(s)).toEqual([drop, grade]);
    removePending("n1", s);
    expect(listPending(s)).toEqual([grade]);
    removePending("missing", s);
    removePending("r1", s);
    expect(listPending(s)).toEqual([]);
    expect(s.m.size).toBe(0);
  });

  it("survives junk and blocked storage", () => {
    const s = memoryStore();
    s.setItem("bamboo.pendingSaves.v1", "not json");
    expect(listPending(s)).toEqual([]);
    s.setItem("bamboo.pendingSaves.v1", JSON.stringify([grade, { kind: "x" }, null]));
    expect(listPending(s)).toEqual([grade]);
    s.setItem("bamboo.pendingSaves.v1", JSON.stringify({}));
    expect(listPending(s)).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(listPending(blocked)).toEqual([]);
    expect(() => addPending(grade, blocked)).not.toThrow();
    expect(listPending(null)).toEqual([]);
  });
});
