import { describe, expect, it } from "vitest";
import { run, USAGE } from "./cli";

describe("bamboo-tools", () => {
  it("prints usage with no command", () => {
    expect(run([])).toEqual({ code: 0, out: USAGE });
  });

  it("refuses commands that don't exist yet", () => {
    const result = run(["import", "--url", "https://example.com/share/abc"]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("'import' is not implemented yet");
  });
});
