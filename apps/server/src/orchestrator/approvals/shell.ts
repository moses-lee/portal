/**
 * The read-only shell allowlist behind `run_command`'s approval. A command runs without asking only
 * when every part of it is parsed and known to only read: it is split on `;`, `&&`, `||` and `|`,
 * each part must start with an allowlisted command whose arguments pass that command's check, and
 * anything the parser does not understand (redirections, command or variable substitution,
 * backslashes, subshells, environment prefixes, unterminated quotes) needs approval. False alarms
 * only cost the user a click; a false "read-only" would run something unasked, so every rule
 * errs towards asking.
 */
import type { ApprovalRisk } from "@portal/contracts/approvals";

export type CommandVerdict = { readOnly: true } | { readOnly: false; reason: string; risk: ApprovalRisk };

/** Whole words that discard output; the only redirections the parser accepts. */
const SAFE_REDIRECTS = ["2>&1", "2>/dev/null", "1>/dev/null", ">/dev/null"];

type Parsed = { segments: string[][] } | { error: string };

const isBoundary = (char: string | undefined) => char === undefined || char === " " || char === "\t" || char === ";" || char === "&" || char === "|";

/** Words of each part between `;`, `&&`, `||` and `|`, with quotes removed; or why the text cannot be trusted. */
export function parseCommand(command: string): Parsed {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "\n" || char === "\r") return { error: "it spans several lines" };
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return { error: "a quote is not closed" };
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (char === '"') {
      const close = command.indexOf('"', i + 1);
      if (close < 0) return { error: "a quote is not closed" };
      const inner = command.slice(i + 1, close);
      if (/[$`\\]/.test(inner)) return { error: "it expands variables or commands inside double quotes" };
      word += inner;
      inWord = true;
      i = close;
      continue;
    }
    if (!inWord) {
      const redirect = SAFE_REDIRECTS.find((token) => command.startsWith(token, i) && isBoundary(command[i + token.length]));
      if (redirect) {
        i += redirect.length - 1;
        continue;
      }
    }
    if (char === ";") {
      if (!endSegment()) return { error: "it has an empty part" };
      continue;
    }
    if (char === "|" || char === "&") {
      const double = command[i + 1] === char;
      if (char === "&" && !double) return { error: "it runs something in the background" };
      if (command[i + 1] === "&" && char === "|") return { error: "it pipes stderr in a way the checker does not read" };
      if (!endSegment()) return { error: "it has an empty part" };
      if (double) i++;
      continue;
    }
    if (char === ">" || char === "<") return { error: "it redirects to or from a file" };
    if (char === "$" || char === "`") return { error: "it substitutes a variable or a command" };
    if (char === "\\") return { error: "it uses backslash escapes" };
    if (char === "(" || char === ")") return { error: "it uses a subshell or grouping" };
    if (char === "#") return { error: "it contains a comment" };
    word += char;
    inWord = true;
  }
  endWord();
  if (words.length === 0) return segments.length === 0 ? { error: "it is empty" } : { error: "it ends with an operator" };
  segments.push(words);
  return { segments };
}

// ---------------------------------------------------------------------------------------------
// Per-command checks: each returns null when the arguments only read, else why not
// ---------------------------------------------------------------------------------------------

type Check = (args: string[]) => string | null;

const anyArgs: Check = () => null;
const noArgs = (name: string): Check => (args) => (args.length === 0 ? null : `${name} with arguments changes something`);

/** An option matching one of `names` (`--output`, `--output=x`), or a short cluster holding one of `letters` (`-uo`). */
function hasOption(args: string[], names: string[], letters = ""): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (names.some((name) => arg === name || arg.startsWith(`${name}=`))) return arg;
    if (letters && /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter))) return arg;
  }
  return null;
}

const forbid = (names: string[], letters = "", why = "writes a file or runs a program"): Check => (args) => {
  const found = hasOption(args, names, letters);
  return found ? `\`${found}\` ${why}` : null;
};

const positional = (args: string[]) => args.filter((arg) => !arg.startsWith("-"));

/** `node --version` and the like: a version check and nothing else. */
const versionOnly = (name: string): Check => (args) =>
  args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]) ? null : `only \`${name} --version\` is read-only`;

const FIND_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"];

const commands: Record<string, Check> = {
  ls: anyArgs, cat: anyArgs, head: anyArgs, tail: anyArgs, wc: anyArgs, pwd: anyArgs, which: anyArgs, echo: anyArgs,
  grep: anyArgs, egrep: anyArgs, fgrep: anyArgs, nl: anyArgs, cut: anyArgs, tr: anyArgs, jq: anyArgs, basename: anyArgs,
  dirname: anyArgs, realpath: anyArgs, whoami: anyArgs, id: anyArgs, uname: anyArgs, du: anyArgs, df: anyArgs, stat: anyArgs,
  diff: anyArgs, cmp: anyArgs, comm: anyArgs, ps: anyArgs, lsof: anyArgs, od: anyArgs, hexdump: anyArgs,
  shasum: anyArgs, sha256sum: anyArgs, md5sum: anyArgs, md5: anyArgs, true: anyArgs,
  hostname: noArgs("hostname"),
  cd: (args) => (args.length <= 1 ? null : "cd takes one folder"),
  rg: forbid(["--pre"], "", "runs a program on every file"),
  find: (args) => {
    const action = args.find((arg) => FIND_ACTIONS.includes(arg));
    return action ? `find \`${action}\` runs a program or changes files` : null;
  },
  sort: forbid(["--output", "--compress-program"], "o"),
  uniq: (args) => (positional(args).length <= 1 ? null : "uniq with two files writes the second"),
  tree: forbid(["-o"], "", "writes a file"),
  date: (args) => (args.every((arg) => arg.startsWith("+") || (arg.startsWith("-") && !["-s", "--set"].some((set) => arg === set || arg.startsWith(`${set}=`))))
    ? null : "date with a positional argument or -s sets the clock"),
  node: versionOnly("node"), npm: versionOnly("npm"), pnpm: versionOnly("pnpm"), python3: versionOnly("python3"),
  git: checkGit,
  gh: checkGh,
};

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

/** Options of log/diff/show and friends that write a file or run a configured program. */
const GIT_OUTPUT = forbid(["--output", "--ext-diff"]);

/**
 * A listing subcommand (branch, tag): only the flags in `flags` (plus `valued`, which take a
 * value), and positional arguments only in list mode, since `git branch x` creates x.
 */
function listing(name: string, flags: string[], valued: string[]): Check {
  return (args) => {
    const listMode = args.includes("-l") || args.includes("--list");
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (valued.some((flag) => arg.startsWith(`${flag}=`))) continue;
      if (valued.includes(arg)) {
        // --merged/--contains take an optional commit; the next word is it when it is not an option.
        if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
        continue;
      }
      if (flags.includes(arg) || /^-n\d*$/.test(arg)) continue;
      if (arg.startsWith("-")) return `\`git ${name} ${arg}\` is not a listing option`;
      if (!listMode) return `\`git ${name} ${arg}\` creates a ${name}`;
    }
    return null;
  };
}

const gitSubcommands: Record<string, Check> = {
  status: anyArgs,
  log: GIT_OUTPUT, show: GIT_OUTPUT, diff: GIT_OUTPUT, shortlog: GIT_OUTPUT, whatchanged: GIT_OUTPUT, "range-diff": GIT_OUTPUT,
  blame: anyArgs, annotate: anyArgs, "ls-files": anyArgs, "ls-tree": anyArgs, "rev-parse": anyArgs, "rev-list": anyArgs,
  describe: anyArgs, "merge-base": anyArgs, "name-rev": anyArgs, "cat-file": anyArgs, "for-each-ref": anyArgs,
  "count-objects": anyArgs, "show-ref": anyArgs, "show-branch": anyArgs, cherry: anyArgs, version: anyArgs,
  grep: forbid(["--open-files-in-pager"], "O", "runs a pager program"),
  branch: listing("branch",
    ["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current", "--color", "--no-color",
      "--column", "--no-column", "-i", "--ignore-case", "--omit-empty"],
    ["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format", "--abbrev"]),
  tag: listing("tag",
    ["-l", "--list", "--color", "--no-color", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty"],
    ["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format"]),
  remote: (args) => {
    if (args.length === 0 || (args.length === 1 && ["-v", "--verbose"].includes(args[0]))) return null;
    if (args[0] === "get-url" || args[0] === "show") return null;
    return `\`git remote ${args[0]}\` changes the remotes`;
  },
  config: (args) => {
    const reads = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "get", "list"];
    const writes = hasOption(args, ["--add", "--unset", "--unset-all", "--replace-all", "--edit", "--rename-section", "--remove-section", "-e"]);
    if (writes) return `\`git config ${writes}\` changes the configuration`;
    return args.some((arg) => reads.includes(arg)) ? null : "git config without --get or --list sets a value";
  },
  stash: (args) => (args[0] === "list" || args[0] === "show" ? null : "only `git stash list` and `git stash show` are read-only"),
  worktree: (args) => (args[0] === "list" ? null : "only `git worktree list` is read-only"),
  reflog: (args) => (args.length === 0 || args[0] === "show" || args[0].startsWith("-") ? null : `\`git reflog ${args[0]}\` rewrites the reflog`),
};

function checkGit(args: string[]): string | null {
  let i = 0;
  // Global options before the subcommand. -c and --exec-path could run anything, so only these pass.
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const arg = args[i];
    if (arg === "-C") {
      i++;
      if (i >= args.length) return "git -C needs a folder";
      continue;
    }
    if (["--no-pager", "-P", "--no-optional-locks"].includes(arg) || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) continue;
    return `\`git ${arg}\` is not an option the checker allows`;
  }
  const sub = args[i];
  if (!sub) return "git without a subcommand";
  const check = Object.hasOwn(gitSubcommands, sub) ? gitSubcommands[sub] : undefined;
  if (!check) return `\`git ${sub}\` is not read-only`;
  return check(args.slice(i + 1));
}

// ---------------------------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------------------------

const ghReads: Record<string, string[]> = {
  pr: ["view", "list", "checks", "diff", "status"],
  issue: ["view", "list", "status"],
  run: ["view", "list"],
  workflow: ["view", "list"],
  repo: ["view"],
  release: ["view", "list"],
  label: ["list"],
  search: ["prs", "issues", "repos", "commits", "code"],
  auth: ["status"],
};

function checkGh(args: string[]): string | null {
  const [group, sub] = args;
  if (!group) return "gh without a command";
  if (!Object.hasOwn(ghReads, group) || !ghReads[group].includes(sub ?? "")) return `\`gh ${group}${sub ? ` ${sub}` : ""}\` is not read-only`;
  const web = hasOption(args.slice(2), ["--web"], "w");
  return web ? `\`${web}\` opens a browser` : null;
}

// ---------------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------------

const DESTRUCTIVE = [
  /(^|[\s;&|(`'"])(rm|rmdir|shred|dd|truncate|mkfs(\.\w+)?|kill|killall|pkill|sudo|chmod|chown)(?=$|[\s;&|)`'"])/,
  /\bgit\s+(-\S+\s+)*(reset\s+.*--hard|clean\b|push\s+.*(--force|-f\b)|branch\s+.*-D\b|stash\s+(drop|clear)\b|worktree\s+remove\b|checkout\s+--\s)/,
];
const OUTBOUND = [
  /(^|[\s;&|(`'"])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|sendmail|gh)(?=$|[\s;&|)`'"])/,
  /\bgit\s+(-\S+\s+)*(push|send-email)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bdocker\s+push\b/,
];

/** How bad a command that needs approval could be, from its text: a label for the dialog, not a guard. */
export function commandRisk(command: string): ApprovalRisk {
  if (DESTRUCTIVE.some((pattern) => pattern.test(command))) return "destructive";
  if (OUTBOUND.some((pattern) => pattern.test(command))) return "outbound";
  return "write";
}

/** Whether `command` only reads; when not, why and how risky it looks. */
export function classifyCommand(command: string): CommandVerdict {
  const notReadOnly = (reason: string): CommandVerdict => ({ readOnly: false, reason, risk: commandRisk(command) });
  const parsed = parseCommand(command.trim());
  if ("error" in parsed) return notReadOnly(`the checker cannot vouch for it: ${parsed.error}`);
  for (const [name, ...args] of parsed.segments) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return notReadOnly("it sets environment variables for the command");
    const check = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!check) return notReadOnly(`\`${name}\` is not on the read-only list`);
    const why = check(args);
    if (why) return notReadOnly(why);
  }
  return { readOnly: true };
}
