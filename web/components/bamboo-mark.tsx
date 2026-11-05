import type { SVGProps } from "react";
import { THEME } from "@/lib/app";

/**
 * The Bamboo mark: a three-segment stalk with two leaves on a green square. Plain SVG so the same
 * element renders in the UI and in the generated PNG icons (app/icon.tsx, app/apple-icon.tsx).
 * Everything stays inside the central 80% circle, so the 512px icon is also a valid maskable icon.
 */
export function BambooMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <rect width="64" height="64" fill={THEME.brand} />
      <g fill={THEME.cream}>
        <rect x="27" y="12" width="10" height="12" rx="2" />
        <rect x="27" y="26" width="10" height="12" rx="2" />
        <rect x="27" y="40" width="10" height="12" rx="2" />
        <path d="M37 22 C41 17 45 14.5 49 14 C47.5 18.5 43 21.5 37 22 Z" />
        <path d="M27 36 C23 32 19 30 14 30 C16 34.5 21 37 27 36 Z" />
      </g>
    </svg>
  );
}
