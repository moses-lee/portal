import type { NextConfig } from "next";

/** Where the Portal server listens; `/api/*` paths that Next.js does not serve itself are proxied there. */
const serverOrigin = process.env.PORTAL_SERVER_ORIGIN ?? `http://127.0.0.1:${process.env.PORTAL_SERVER_PORT ?? 3100}`;

const nextConfig: NextConfig = {
  transpilePackages: ["@portal/contracts"],
  allowedDevOrigins: ["100.115.116.107", "mini", "*.ts.net", "localhost"],
  async rewrites() {
    // afterFiles: routes this app still implements win; everything else under /api goes to the server.
    return { afterFiles: [{ source: "/api/:path*", destination: `${serverOrigin}/api/:path*` }] };
  },
  serverExternalPackages: [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/codex-acp",
    "@agentclientprotocol/sdk",
  ],
};

export default nextConfig;
