import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second `next dev` (dev:seeded, dev:prod-copy, pnpm shot) needs its own build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // @bamboo/db and @bamboo/shared ship TypeScript source (no build step).
  transpilePackages: ["@bamboo/db", "@bamboo/shared"],
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Keep the dev indicator off the bottom tab bar (it covered the Today tab on a phone).
  devIndicators: { position: "top-right" },
};

export default nextConfig;
