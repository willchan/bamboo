import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE } from "./index";

describe("@bamboo/shared", () => {
  it("loads", () => {
    expect(SHARED_PACKAGE).toBe("@bamboo/shared");
  });
});
