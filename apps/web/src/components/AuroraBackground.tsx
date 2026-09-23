"use client";

import { useSyncExternalStore } from "react";
import type { AgentActivity } from "@/lib/agent-activity";

const subscribe = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/** CSS aurora inspired by shadcn.io/background/aurora, tuned for a reading workspace. */
export default function AuroraBackground({
  activity,
}: {
  activity: AgentActivity;
}) {
  const visible = useSyncExternalStore(
    subscribe,
    () => !document.hidden,
    () => true,
  );
  return (
    <div
      className="aurora"
      data-activity={activity}
      data-paused={!visible}
      aria-hidden="true"
    >
      <div className="aurora-ribbons" />
      <div className="aurora-ribbons aurora-ribbons-far" />
    </div>
  );
}
