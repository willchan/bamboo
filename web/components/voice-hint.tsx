"use client";
// One-time hint when the device has no Mandarin voice (DESIGN §6 *Audio*).
import { useEffect, useState } from "react";
import { hasChineseVoice } from "@/lib/audio";

const KEY = "bamboo.voiceHintDismissed";

export function VoiceHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(KEY) === "1";
    } catch {
      // Storage can be unavailable (private mode); show the hint anyway.
    }
    if (dismissed) return;
    void hasChineseVoice().then((ok) => setShow(!ok));
  }, []);

  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // ignore
    }
    setShow(false);
  };
  return (
    <div role="note" className="rounded-xl border border-border bg-card p-3 text-sm">
      <p>
        No Mandarin voice found. On iPhone:{" "}
        <b>Settings → Accessibility → Spoken Content → Voices → Chinese</b>, then pick a (Enhanced)
        voice.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="mt-2 text-primary underline underline-offset-4"
      >
        Got it
      </button>
    </div>
  );
}
