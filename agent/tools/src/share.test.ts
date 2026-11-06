import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hanziKey, turnKey } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import {
  flattenRich,
  isShareLink,
  parseBatchexecute,
  readShareLink,
  ShareParseError,
  type HttpRequest,
  type HttpRequestInit,
} from "./share";

const fixture = (name: string) =>
  readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");
const rpc = fixture("share-rpc.txt");
const expected = JSON.parse(fixture("share-page.expected.json")) as {
  title: string;
  turns: { user: string; reply: string }[];
};

describe("parseBatchexecute", () => {
  it("parses the synthetic RPC fixture into the expected turns, exactly", () => {
    const conv = parseBatchexecute(rpc);
    expect(conv.title).toBe(expected.title);
    expect(conv.turns).toEqual(
      expected.turns.map((t) => ({ user_text: t.user, reply_text: t.reply })),
    );
    expect(conv.unknownComponents).toEqual({});
  });

  it("keys the image-only prompt on its reply (DESIGN §4.5)", () => {
    const { turns } = parseBatchexecute(rpc);
    const image = turns.find((t) => t.user_text === "")!;
    expect(image).toBeDefined();
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(turnKey(image, "link")).toBe(sha(`\n${hanziKey(image.reply_text)}`));
    expect(turnKey(image, "link")).not.toBe(turnKey({ ...image, reply_text: "别的" }, "link"));
    const keys = turns.map((t) => turnKey(t, "link"));
    expect(new Set(keys).size).toBe(turns.length);
  });

  it("fails loudly on a missing frame, a null payload or a missing path", () => {
    expect(() => parseBatchexecute(")]}'\n\n12\n[]")).toThrow(ShareParseError);
    expect(() => parseBatchexecute('[["wrb.fr","ujx1Bf",null,null,null,null,"generic"]]')).toThrow(
      /deleted or unknown link/u,
    );
    const noTurns = JSON.stringify([["wrb.fr", "ujx1Bf", JSON.stringify([[null, null]])]]);
    expect(() => parseBatchexecute(noTurns)).toThrow(/no turns/u);
    const badTurn = JSON.stringify([["wrb.fr", "ujx1Bf", JSON.stringify([[null, [[]]]])]]);
    expect(() => parseBatchexecute(badTurn)).toThrow(/turn 0/u);
    const noTitle = JSON.stringify([["wrb.fr", "ujx1Bf", JSON.stringify([[null, [], null]])]]);
    expect(() => parseBatchexecute(noTitle)).toThrow(/no title/u);
  });
});

describe("flattenRich", () => {
  it("keeps TextBox and Section text, lists checklist labels, drops chips and media", () => {
    const md = [
      '<Section title="Say it">',
      '<TextBox text="够了。" subtext="Gòu le."/>',
      "</Section>",
      '<TemplateWidget templateName="checklist" header_title="Steps">',
      '```json\n{"items":[{"label":"Add water"},{"label":"Close lid"}]}\n```',
      "</TemplateWidget>",
      '<ElicitationsGroup><Elicitation text="More?"/></ElicitationsGroup>',
      '<Image src="x" caption="Some page"/><FollowUp text="next"/>',
    ].join("\n");
    expect(flattenRich(md)).toBe("Say it\n够了。\nGòu le.\n\nSteps\n- Add water\n- Close lid");
  });

  it("counts unknown components and unparsed widgets", () => {
    const unknown = new Map<string, number>();
    flattenRich(
      '<Map lat="1"/> x <Map/> <TemplateWidget a="b">```json\n{"x":1}\n```</TemplateWidget>',
      unknown,
    );
    expect(Object.fromEntries(unknown)).toEqual({ Map: 2, "TemplateWidget(unparsed)": 1 });
  });

  it("decodes attribute entities", () => {
    expect(flattenRich('<TextBox text="&quot;好&quot; &amp; &#22909; &lt;3"/>')).toBe(
      '"好" & 好 <3',
    );
  });
});

describe("isShareLink", () => {
  it("accepts the three link hosts and nothing else", () => {
    for (const ok of [
      "https://share.gemini.google/AbC123",
      "https://gemini.google.com/share/0a1b2c3d",
      "https://g.co/gemini/share/0a1b2c3d?x=1",
    ])
      expect(isShareLink(ok)).toBe(true);
    for (const bad of [
      "http://gemini.google.com/share/abc",
      "https://evil.example/share/abc",
      "https://gemini.google.com/app/abc",
    ])
      expect(isShareLink(bad)).toBe(false);
  });
});

describe("readShareLink", () => {
  const page = '<html><script>WIZ_global_data={"cfb2h":"boq_build_1","FdrFJe":"-123"}</script>';

  function fakeHttp(overrides: { rpcStatus?: number; rpcText?: string; pageStatus?: number } = {}) {
    const seen: { url: string; init?: HttpRequestInit }[] = [];
    const request: HttpRequest = async (url, init) => {
      seen.push({ url, init });
      const u = new URL(url);
      if (u.host === "share.gemini.google")
        return {
          status: 301,
          location: "https://gemini.google.com/share/0a1b2c3d?skid=x",
          text: "",
        };
      if (u.pathname.startsWith("/share/"))
        return { status: overrides.pageStatus ?? 200, location: null, text: page };
      if (u.pathname.endsWith("/batchexecute"))
        return {
          status: overrides.rpcStatus ?? 200,
          location: null,
          text: overrides.rpcText ?? rpc,
        };
      return { status: 404, location: null, text: "" };
    };
    return { request, seen };
  }

  it("follows the redirect, then calls the share RPC with the page's build and session ids", async () => {
    const { request, seen } = fakeHttp();
    const conv = await readShareLink("https://share.gemini.google/AbC123", request, () => 4242);
    expect(conv.turns).toHaveLength(expected.turns.length);
    expect(seen).toHaveLength(3);
    const call = seen[2]!;
    const u = new URL(call.url);
    expect(u.host).toBe("gemini.google.com");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      rpcids: "ujx1Bf",
      "source-path": "/share/0a1b2c3d",
      hl: "en-US",
      _reqid: "4242",
      rt: "c",
      bl: "boq_build_1",
      "f.sid": "-123",
    });
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers?.["x-same-domain"]).toBe("1");
    expect(new URLSearchParams(call.init?.body).get("f.req")).toBe(
      JSON.stringify([[["ujx1Bf", '[null,"0a1b2c3d",[4]]', null, "generic"]]]),
    );
  });

  it("reports HTTP failures and non-links as share_parse_failed", async () => {
    await expect(readShareLink("https://example.com/x", fakeHttp().request)).rejects.toThrow(
      ShareParseError,
    );
    await expect(
      readShareLink("https://share.gemini.google/AbC123", fakeHttp({ pageStatus: 404 }).request),
    ).rejects.toThrow(/HTTP 404/u);
    await expect(
      readShareLink("https://share.gemini.google/AbC123", fakeHttp({ rpcStatus: 500 }).request),
    ).rejects.toThrow(/batchexecute HTTP 500/u);
    await expect(
      readShareLink(
        "https://share.gemini.google/AbC123",
        fakeHttp({ rpcText: '[["wrb.fr",1' }).request,
      ),
    ).rejects.toThrow(ShareParseError);
  });

  it("gives up on a redirect loop or a page that isn't /share/<id>", async () => {
    const loop: HttpRequest = async (url) => ({ status: 302, location: url, text: "" });
    await expect(readShareLink("https://g.co/gemini/share/abc", loop)).rejects.toThrow(
      /too many redirects/u,
    );
    const elsewhere: HttpRequest = async (url) =>
      new URL(url).host === "g.co"
        ? { status: 302, location: "https://gemini.google.com/app", text: "" }
        : { status: 200, location: null, text: "" };
    await expect(readShareLink("https://g.co/gemini/share/abc", elsewhere)).rejects.toThrow(
      /did not land/u,
    );
  });
});
