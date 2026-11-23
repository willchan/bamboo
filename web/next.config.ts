import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Which deploy a page came from (lib/client/build.ts, DESIGN §6 *Saving*): a page from an older
  // deploy reloads into the new one before its server actions fail.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "dev",
  },
  // A second `next dev` (dev:seeded, dev:prod-copy, pnpm shot) needs its own build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // @bamboo/db and @bamboo/shared ship TypeScript source (no build step).
  transpilePackages: ["@bamboo/db", "@bamboo/shared"],
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Next.js traces sharp (~19 MB of libvips) into every server function for the image optimizer.
  // Nothing here uses next/image, and Vercel optimizes images outside the function anyway, so
  // leaving it out halves each deployment's Function Storage (free tier: 10 GB per team).
  outputFileTracingExcludes: {
    "*": [
      // Relative to web/; pnpm keeps packages in the workspace root's node_modules/.pnpm.
      "../node_modules/.pnpm/sharp@*/**",
      "../node_modules/.pnpm/@img+*/**",
      // …and the symlinks to it, which would otherwise dangle.
      "../node_modules/.pnpm/next@*/node_modules/sharp",
      "../node_modules/.pnpm/node_modules/sharp",
    ],
  },
  // No dev indicator: on a phone every corner covers a control (the tab bar at the bottom, the
  // review screen's ✕ and ⋯ at the top). Runtime errors still open Next's error overlay.
  devIndicators: false,
};

export default nextConfig;
