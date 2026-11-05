import { describe, expect, it } from "vitest";
import { banner } from "./index";

describe("worker", () => {
  it("resolves @bamboo/shared from the workspace", () => {
    expect(banner()).toContain("@bamboo/shared");
  });
});
