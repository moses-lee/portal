import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AgentLogo({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  if (agentId !== "claude" && agentId !== "codex")
    return (
      <Bot aria-label={agentId} className={cn("size-4 shrink-0", className)} />
    );
  const label = agentId === "claude" ? "Claude Code" : "Codex";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("agent-logo", `agent-logo-${agentId}`, className)}
    />
  );
}
