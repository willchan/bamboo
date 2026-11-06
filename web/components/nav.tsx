"use client";
// Bottom tab bar for the main pages: thumb-reachable on the phone.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Today" },
  { href: "/queue", label: "Up next" },
  { href: "/phrases", label: "Phrases" },
  { href: "/imports", label: "Imports" },
  { href: "/stats", label: "Stats" },
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur"
    >
      <ul className="mx-auto flex max-w-md">
        {TABS.map((t) => {
          const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 items-center justify-center text-sm font-medium ${
                  active ? "text-primary" : "text-muted"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
