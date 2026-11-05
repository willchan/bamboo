import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @bamboo/db and @bamboo/shared ship TypeScript source (no build step).
  transpilePackages: ["@bamboo/db", "@bamboo/shared"],
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
