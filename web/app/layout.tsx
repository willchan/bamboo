import type { Metadata, Viewport } from "next";
import { APP_NAME, APP_TAGLINE, THEME } from "@/lib/app";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
  // iOS "Add to Home Screen": open standalone, with the app's own name under the icon.
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME.light },
    { media: "(prefers-color-scheme: dark)", color: THEME.dark },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
