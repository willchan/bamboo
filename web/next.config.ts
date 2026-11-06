import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @bamboo/db and @bamboo/shared ship TypeScript source (no build step).
  transpilePackages: ["@bamboo/db", "@bamboo/shared"],
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Keep the dev indicator off the bottom tab bar (it covered the Today tab on a phone).
  devIndicators: { position: "top-right" },
};

export default nextConfig;
