import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.115.116.107", "*.ts.net", "localhost"],
  serverExternalPackages: [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/codex-acp",
    "@agentclientprotocol/sdk",
    "node-pty",
    "@xterm/headless",
    "@xterm/addon-serialize",
  ],
};

export default nextConfig;
