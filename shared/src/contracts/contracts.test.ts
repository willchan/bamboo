import { describe, expect, it } from "vitest";
import { sharedConfig } from "../config";
import {
  ClaimedJob,
  CompleteRequest,
  ExtractTurnResult,
  ImportRequest,
  KnownRequest,
  NotificationsResponse,
} from "./index";

const item = {
  kind: "term",
  hanzi: "高压锅",
  english: "pressure cooker",
  addressee: "yuesao",
  heard_as: "gaoyaguo",
  example: { hanzi: "用高压锅煮。", english: null },
  usefulness: 4,
  tags: ["food"],
};

describe("contracts", () => {
  it("parse an extract result and enforce its limits", () => {
    expect(ExtractTurnResult.parse({ turn_kind: "decode", items: [item] }).items).toHaveLength(1);
    const many = Array.from({ length: sharedConfig.extraction.maxItems + 1 }, () => item);
    expect(ExtractTurnResult.safeParse({ turn_kind: "say", items: many }).success).toBe(false);
    expect(
      ExtractTurnResult.safeParse({ turn_kind: "say", items: [{ ...item, usefulness: 6 }] })
        .success,
    ).toBe(false);
    expect(
      ExtractTurnResult.safeParse({
        turn_kind: "say",
        items: [{ ...item, english: "x".repeat(121) }],
      }).success,
    ).toBe(false);
  });

  it("default an import's prompt text and `more`", () => {
    const r = ImportRequest.parse({
      kind: "text",
      origin: "web",
      turns_total: 1,
      turns: [{ reply_text: "高压锅", position: 0 }],
    });
    expect(r.turns[0]!.user_text).toBe("");
    expect(r.more).toBe(false);
  });

  it("cap known keys", () => {
    const keys = Array.from({ length: sharedConfig.imports.maxKnownKeys + 1 }, (_, i) => `k${i}`);
    expect(KnownRequest.safeParse({ turn_keys: keys }).success).toBe(false);
    expect(KnownRequest.safeParse({ turn_keys: keys.slice(1) }).success).toBe(true);
  });

  it("discriminate complete bodies on status", () => {
    expect(
      CompleteRequest.parse({ job_id: "j", attempt: 1, status: "failed", error: "x" }),
    ).toEqual({ job_id: "j", attempt: 1, status: "failed", error: "x" });
    expect(CompleteRequest.safeParse({ job_id: "j", attempt: 1, status: "failed" }).success).toBe(
      false,
    );
    expect(
      ClaimedJob.safeParse({
        job_id: "j",
        type: "extract_turn",
        attempt: 1,
        lease_expires_at: 1,
        input: { turn_id: "t", conversation_title: null, user_text: "", reply_text: "x" },
      }).success,
    ).toBe(true);
    expect(NotificationsResponse.parse({ notifications: [] })).toEqual({ notifications: [] });
  });
});
