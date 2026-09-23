import type { NextConfig } from "next";

/**
 * Where the Portal server listens; `/api/*` paths that Next.js does not serve itself are proxied there.
 * Read when the config loads, so `next build` bakes the destination into the build: `next start`
 * proxies to whatever the build saw, and changing these means rebuilding.
 */
const serverOrigin = process.env.PORTAL_SERVER_ORIGIN ?? `http://127.0.0.1:${process.env.PORTAL_SERVER_PORT ?? 3100}`;

const nextConfig: NextConfig = {
  transpilePackages: ["@portal/contracts", "@portal/shared"],
  allowedDevOrigins: ["100.115.116.107", "mini", "*.ts.net", "localhost"],
  async rewrites() {
    // afterFiles: routes this app still implements win; everything else under /api goes to the server.
    return { afterFiles: [{ source: "/api/:path*", destination: `${serverOrigin}/api/:path*` }] };
  },
};

export default nextConfig;
