// PDF exports (DESIGN §5.2 *PDF*): `pdftotext -layout -enc UTF-8`, then the shared segmenter.
import { execFile } from "node:child_process";
import { segmentPdfText, type Segmented } from "@bamboo/shared";

export const POPPLER_HINT = "install poppler: brew install poppler";

export class PdfError extends Error {
  override name = "PdfError";
  constructor(
    readonly code: "pdftotext_missing" | "pdf_unreadable",
    message: string,
  ) {
    super(message);
  }
}

/** Run `pdftotext -layout -enc UTF-8 <file> -` and return its stdout. */
export function pdfToText(file: string, bin = process.env.PDFTOTEXT ?? "pdftotext") {
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      ["-layout", "-enc", "UTF-8", file, "-"],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
          return reject(new PdfError("pdftotext_missing", `pdftotext not found: ${POPPLER_HINT}`));
        reject(new PdfError("pdf_unreadable", `pdftotext failed: ${stderr.trim() || err.message}`));
      },
    );
  });
}

/** A PDF file → title and turns. */
export async function readPdf(file: string, bin?: string): Promise<Segmented> {
  return segmentPdfText(await pdfToText(file, bin));
}
