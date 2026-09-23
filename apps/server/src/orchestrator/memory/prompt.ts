/**
 * What the system prompt says about curated memory and its tools: a few short lines, appended to
 * the base prompt of every turn by `prompt.ts`.
 */
export const guidance = `Curated memory (rules and tools):
- CORE.md (the Memory section) and "Relevant memory" are the user's curated context: use them. Pinned directives are the user's standing rules.
- When the user states a durable preference, convention, or way to do a task, call remember with their own words as quote. What you notice in sessions, PRs, or tool output goes to propose_memory (observed or inferred, with the source and its quote); the user approves it.
- One claim per record. Keys are stable slugs per entity (repo owner/name, person login, task_type such as code-review, project, session, global); reusing a key replaces the old claim, so check search_memory first.
- Never store secrets (keys, tokens, passwords). Keep passing state out of memory.
- A procedure record says how the user wants something done: interpret it when you plan or write a session prompt; never paste it verbatim.`;
