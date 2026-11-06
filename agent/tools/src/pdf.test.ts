import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfError, pdfToText, readPdf } from "./pdf";

/** A one-page PDF (Helvetica, ASCII) with text at the given x/y positions. Synthetic. */
export function makePdf(lines: { x: number; y: number; text: string }[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/gu, "\\$&");
  const stream = lines
    .map((l) => `BT /F1 11 Tf ${l.x} ${l.y} Td (${esc(l.text)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const hasPdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("pdfToText", () => {
  it("says to install poppler when pdftotext is missing", async () => {
    const err = await pdfToText("/tmp/x.pdf", "/nonexistent/pdftotext").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfError);
    expect((err as PdfError).code).toBe("pdftotext_missing");
    expect((err as PdfError).message).toContain("install poppler: brew install poppler");
  });

  // CI has no poppler: the segmentation itself is tested on text in @bamboo/shared.
  it.skipIf(!hasPdftotext)("reads a synthetic PDF with the real pdftotext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-pdf-"));
    const file = join(dir, "synthetic.pdf");
    writeFileSync(
      file,
      makePdf([
        { x: 40, y: 750, text: "Kitchen Words" },
        { x: 330, y: 700, text: "How do I say rice cooker?" },
        { x: 40, y: 650, text: "You can say: dianfanbao." },
      ]),
    );
    const conv = await readPdf(file);
    expect(conv.title).toBe("Kitchen Words");
    expect(conv.turns).toEqual([
      { user_text: "How do I say rice cooker?", reply_text: "You can say: dianfanbao." },
    ]);
    const bad = join(dir, "bad.pdf");
    writeFileSync(bad, "not a pdf");
    await expect(pdfToText(bad)).rejects.toMatchObject({ code: "pdf_unreadable" });
  });
});
