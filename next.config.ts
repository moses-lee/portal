import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.115.116.107", "*.ts.net", "localhost"],
  serverExternalPackages: ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/sdk"],
};

export default nextConfig;
