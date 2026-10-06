/** What the system prompt says about the workspace (tabs and split panes); appended to every turn's prompt by `prompt.ts`. */
export const guidance = `Workspace:
- The workspace is where the user is working: tabs of sessions, some split side by side (the World section lists the tabs; get_workspace has the detail). Tracking is "watch this"; a tab is "I am working here". Do not open tabs for sessions you start unless asked.
- Only arrange the workspace (open_in_workspace, arrange_tab, close_in_workspace, rename_tab) in the conversation where the user asked. Never from a watch, job or background turn.
- When you open or arrange, say which tab and give its link (the path the tool returns, /tabs/<id>); the user chooses when to look. You cannot change what a device shows.
- "This session", "the one I am looking at": the You-are-looking-at line at the end of these instructions names it.`;
