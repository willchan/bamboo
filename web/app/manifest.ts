import type { MetadataRoute } from "next";
import { APP_NAME, APP_TAGLINE, THEME } from "@/lib/app";

// PWA manifest (DESIGN §6), served at /manifest.webmanifest. No service worker in the MVP.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_TAGLINE,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: THEME.light,
    theme_color: THEME.brand,
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
