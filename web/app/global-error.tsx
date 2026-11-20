"use client";
// The last-resort error screen (DESIGN §8.5): reports the error (fixed fields only) and offers a
// reload. It replaces the root layout, so it brings its own html and styles.
import { useEffect } from "react";
import { reportFailure } from "@/lib/client/client-log";
import "./globals.css";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportFailure({ where: "render", err: error });
  }, [error]);
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center gap-4 px-5 text-center font-sans">
        <p className="text-lg font-semibold">Something went wrong.</p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="h-12 rounded-2xl bg-primary px-6 font-semibold text-primary-foreground"
        >
          Reload
        </button>
      </body>
    </html>
  );
}
