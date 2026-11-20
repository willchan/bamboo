"use client";
// App-wide failure handling (DESIGN §6 *Saving*, §8.5): reload into a newer deploy when the app
// comes back to the foreground, report uncaught errors, and outside the review screen send any
// grades a reload left behind (the review screen sends them itself, in order with new ones).
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { checkBuild, reloadForNewBuild } from "@/lib/client/build";
import { reportFailure } from "@/lib/client/client-log";
import { handleFailure } from "@/lib/client/failure";
import { listPending, removePending } from "@/lib/client/pending-saves";
import { sendPendingSave } from "@/lib/client/send-save";

/** Uncaught errors reported per page load: one bug in a loop mustn't flood the log. */
const MAX_WINDOW_REPORTS = 5;

export function AppHealth() {
  const pathname = usePathname();
  const router = useRouter();
  const flushing = useRef(false);

  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      if ((await checkBuild()) !== "changed") return;
      reportFailure({ where: "version", err: null, kind: "stale" });
      reloadForNewBuild();
    };
    void check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  useEffect(() => {
    let reports = 0;
    const report = (err: unknown) => {
      if (reports++ < MAX_WINDOW_REPORTS) reportFailure({ where: "window", err });
    };
    const onError = (e: ErrorEvent) => report(e.error);
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    if (pathname.startsWith("/review") || pathname.startsWith("/sign-in")) return;
    if (flushing.current || listPending().length === 0) return;
    flushing.current = true;
    void (async () => {
      try {
        for (const p of listPending()) {
          try {
            await sendPendingSave(p);
          } catch (err) {
            await handleFailure({ where: "resend", err });
            return;
          }
          removePending(p.id);
        }
        router.refresh();
      } finally {
        flushing.current = false;
      }
    })();
  }, [pathname, router]);

  return null;
}
