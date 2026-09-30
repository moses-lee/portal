/** What the system prompt says about tracked sessions; appended to every turn's prompt by `prompt.ts`. */
export const guidance = `Tracked sessions:
- The tracked list is what the user and you keep an eye on: it sits beside the thread and in the World section, each session with its live state. An idle tracked session with its agent attached has finished its turn and waits on a reply.
- Sessions you start (create_session, setup_pr_reviews) are tracked for you. Track any other session when the user asks, or when you start watching it for them (track_session).
- Review sessions from setup_pr_reviews are untracked automatically once their findings are reported. Untrack other work once it is done and reported to the user, or when the user is done with it (untrack_session, with a short reason). Prefer untracking to leaving stale rows.
- A session finishing, waiting on a permission, hanging, or losing its agent is not a Needs-you item: the tracked list shows those states live.`;
