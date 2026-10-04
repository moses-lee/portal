/**
 * The session header's status line. Pure, so the node test runner can load it.
 */
import { activityLabels, type AgentActivity } from "./agent-activity.ts";
import { sessionStateLabels, type SessionState } from "./session-state.ts";

/**
 * What the header says under the title: the activity's label, except that hung and background
 * read as the sidebar dot says them ("Hung", "Background"), where `AgentActivity` folds them into
 * "Needs attention" and "Working". Background task titles follow when any run.
 */
export function sessionStatusLabel(
  activity: AgentActivity,
  state: SessionState,
  backgroundTasks: readonly { title: string }[] = [],
): string {
  const base =
    state === "hung"
      ? sessionStateLabels.hung
      : state === "background" && activity !== "error"
        ? sessionStateLabels.background
        : activityLabels[activity];
  const titles = backgroundTasks.map((task) => task.title.trim()).filter(Boolean);
  return titles.length ? `${base} · ${titles.join(", ")}` : base;
}
