import assert from "node:assert/strict";
import test from "node:test";
import {
  bareTokenCandidates, classifyHref, hrefScheme, isAbsolutePath, keepMarkdownUrl, parseLineSuffix, pathCandidate,
  rawFileUrl, rehypePathTokens,
} from "../src/lib/file-links.ts";

const origin = "http://portal.test:3000";

test("parseLineSuffix strips :line, :line:col and #L anchors", () => {
  assert.deepEqual(parseLineSuffix("src/a.ts:42"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(parseLineSuffix("src/a.ts:42:7"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(parseLineSuffix("/tmp/x.md#L3"), { path: "/tmp/x.md", line: 3 });
  assert.deepEqual(parseLineSuffix("/tmp/x.md#L3-L9"), { path: "/tmp/x.md", line: 3 });
  assert.deepEqual(parseLineSuffix("/tmp/x.md#L3C2"), { path: "/tmp/x.md", line: 3 });
  assert.deepEqual(parseLineSuffix("docs/PLAN.md"), { path: "docs/PLAN.md", line: null });
  assert.deepEqual(parseLineSuffix("a.ts:0"), { path: "a.ts", line: null });
  assert.deepEqual(parseLineSuffix(":42"), { path: ":42", line: null });
});

test("hrefScheme tells a URL scheme from a path with a line", () => {
  assert.equal(hrefScheme("https://x.dev"), "https");
  assert.equal(hrefScheme("MAILTO:a@b.c"), "mailto");
  assert.equal(hrefScheme("README.md:42"), null);
  assert.equal(hrefScheme("README.md:42:3"), null);
  assert.equal(hrefScheme("src/a.ts:42"), null);
  assert.equal(hrefScheme("./x"), null);
});

test("classifyHref: schemes are external, first match wins", () => {
  assert.deepEqual(classifyHref("https://example.com/a", origin), { kind: "external", href: "https://example.com/a" });
  assert.deepEqual(classifyHref("mailto:a@b.c", origin), { kind: "external", href: "mailto:a@b.c" });
  assert.deepEqual(classifyHref("vscode://file/x", origin), { kind: "external", href: "vscode://file/x" });
  assert.deepEqual(classifyHref("//cdn.example.com/x.js", origin), { kind: "external", href: "//cdn.example.com/x.js" });
  assert.deepEqual(classifyHref("file://other-host/x", origin), { kind: "external", href: "file://other-host/x" });
});

test("classifyHref: Portal routes navigate in place", () => {
  assert.deepEqual(classifyHref("/tabs/t1", origin), { kind: "app", path: "/tabs/t1" });
  assert.deepEqual(classifyHref("/sessions/s1", null), { kind: "app", path: "/sessions/s1" });
  assert.deepEqual(classifyHref(`${origin}/tabs/t1?pane=p`, origin), { kind: "app", path: "/tabs/t1?pane=p" });
  // Another origin's Portal route is just a web page.
  assert.equal(classifyHref("http://elsewhere/tabs/t1", origin).kind, "external");
});

test("classifyHref: file URLs, absolute, home and relative paths are files", () => {
  assert.deepEqual(classifyHref("file:///tmp/a%20b.txt", origin), { kind: "file", path: "/tmp/a b.txt", line: null });
  assert.deepEqual(classifyHref("file://localhost/tmp/a.txt:3", origin), { kind: "file", path: "/tmp/a.txt", line: 3 });
  assert.deepEqual(classifyHref("/tmp/file.txt", origin), { kind: "file", path: "/tmp/file.txt", line: null });
  assert.deepEqual(classifyHref("/tmp/file.txt:3", origin), { kind: "file", path: "/tmp/file.txt", line: 3 });
  assert.deepEqual(classifyHref("~/notes.md#L12", origin), { kind: "file", path: "~/notes.md", line: 12 });
  assert.deepEqual(classifyHref("docs/PLAN.md", origin), { kind: "file", path: "docs/PLAN.md", line: null });
  assert.deepEqual(classifyHref("./x", origin), { kind: "file", path: "./x", line: null });
  assert.deepEqual(classifyHref("../x.ts:4:2", origin), { kind: "file", path: "../x.ts", line: 4 });
  assert.deepEqual(classifyHref("README.md:42", origin), { kind: "file", path: "README.md", line: 42 });
  assert.deepEqual(classifyHref("docs/%C3%A9t%C3%A9.md", origin), { kind: "file", path: "docs/été.md", line: null });
});

test("classifyHref: hosts with ports, bare queries and Windows paths are not files, only text", () => {
  assert.deepEqual(classifyHref("localhost:3000", origin), { kind: "text" });
  assert.deepEqual(classifyHref("example.com:8080", origin), { kind: "text" });
  assert.deepEqual(classifyHref("127.0.0.1:80", origin), { kind: "text" });
  assert.deepEqual(classifyHref("?q=1", origin), { kind: "text" });
  assert.deepEqual(classifyHref("C:\\Users\\me\\a.txt", origin), { kind: "text" });
  assert.deepEqual(classifyHref("c:/Users/me/a.txt", origin), { kind: "text" });
  // A file with a line still reads as one, with or without an extension.
  assert.deepEqual(classifyHref("README.md:42", origin), { kind: "file", path: "README.md", line: 42 });
  assert.deepEqual(classifyHref("Makefile:12", origin), { kind: "file", path: "Makefile", line: 12 });
});

test("classifyHref: a fragment that is not a line is dropped from a file path", () => {
  assert.deepEqual(classifyHref("docs/FILES.md#section", origin), { kind: "file", path: "docs/FILES.md", line: null });
  assert.deepEqual(classifyHref("file:///tmp/a.md#intro", origin), { kind: "file", path: "/tmp/a.md", line: null });
  assert.deepEqual(classifyHref("docs/FILES.md#L7", origin), { kind: "file", path: "docs/FILES.md", line: 7 });
  assert.deepEqual(classifyHref("docs/a%23b.md", origin), { kind: "file", path: "docs/a#b.md", line: null });
});

test("classifyHref: anchors and empty hrefs are left alone", () => {
  assert.deepEqual(classifyHref("#notes", origin), { kind: "none" });
  assert.deepEqual(classifyHref("", origin), { kind: "none" });
  assert.deepEqual(classifyHref(undefined, origin), { kind: "none" });
});

test("keepMarkdownUrl keeps file and line-suffixed links, drops unsafe schemes", () => {
  assert.equal(keepMarkdownUrl("file:///tmp/a"), "file:///tmp/a");
  assert.equal(keepMarkdownUrl("README.md:42"), "README.md:42");
  assert.equal(keepMarkdownUrl("https://x.dev"), "https://x.dev");
  assert.equal(keepMarkdownUrl("docs/a.md"), "docs/a.md");
  assert.equal(keepMarkdownUrl("javascript:alert(1)"), "");
  assert.equal(keepMarkdownUrl("data:text/html,x"), "");
});

test("rawFileUrl sends cwd only for relative paths", () => {
  assert.equal(rawFileUrl("/tmp/a b.txt", "/repo"), "/api/files/raw?path=%2Ftmp%2Fa+b.txt");
  assert.equal(rawFileUrl("~/x", "/repo"), "/api/files/raw?path=%7E%2Fx");
  assert.equal(rawFileUrl("docs/a.md", "/repo"), "/api/files/raw?path=docs%2Fa.md&cwd=%2Frepo");
  assert.equal(rawFileUrl("docs/a.md", null), "/api/files/raw?path=docs%2Fa.md");
  assert.equal(isAbsolutePath("~"), true);
  assert.equal(isAbsolutePath("~foo"), false);
});

test("pathCandidate: slashes or known extensions, no prose or code", () => {
  assert.deepEqual(pathCandidate("src/lib/a.ts"), { path: "src/lib/a.ts", line: null });
  assert.deepEqual(pathCandidate("src/lib/a.ts:42"), { path: "src/lib/a.ts", line: 42 });
  assert.deepEqual(pathCandidate("README.md"), { path: "README.md", line: null });
  assert.deepEqual(pathCandidate("/tmp/out"), { path: "/tmp/out", line: null });
  assert.deepEqual(pathCandidate("~/repos/portal/"), { path: "~/repos/portal/", line: null });
  assert.deepEqual(pathCandidate("node_modules/@scope/pkg"), { path: "node_modules/@scope/pkg", line: null });
  for (const text of [
    "pnpm test", "a == b", "foo()", "https://x.dev/a", "useState", "v1.2.3", "1.2/3.4", "24/7", "/", "./", "..",
    "--flag/x", "x.unknownext", "a,b/c", "$HOME/x", "`a/b`", "Array<string>", "a//b", "C:/x", "#L4",
  ])
    assert.equal(pathCandidate(text), null, text);
});

test("bareTokenCandidates trims prose punctuation and keeps line suffixes", () => {
  const text = "See (docs/PLAN.md), then src/a.ts:42. Not and-or or 1.5 or e.g. this.";
  assert.deepEqual(
    bareTokenCandidates(text).map(({ start, end, path, line }) => [text.slice(start, end), path, line]),
    [
      ["docs/PLAN.md", "docs/PLAN.md", null],
      ["src/a.ts:42", "src/a.ts", 42],
    ],
  );
});

test("rehypePathTokens wraps candidate words in prose only", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [
          { type: "text", value: "Wrote docs/PLAN.md and " },
          { type: "element", tagName: "code", children: [{ type: "text", value: "src/a.ts" }] },
          { type: "element", tagName: "a", children: [{ type: "text", value: "lib/b.ts" }] },
          { type: "text", value: " ok" },
        ],
      },
      { type: "element", tagName: "pre", children: [{ type: "text", value: "x/y.ts" }] },
    ],
  };
  rehypePathTokens()(tree);
  const [p, pre] = tree.children;
  assert.deepEqual(p.children.slice(0, 3), [
    { type: "text", value: "Wrote " },
    {
      type: "element",
      tagName: "span",
      properties: { dataPathToken: "docs/PLAN.md" },
      children: [{ type: "text", value: "docs/PLAN.md" }],
    },
    { type: "text", value: " and " },
  ]);
  assert.equal(p.children[3].tagName, "code");
  assert.deepEqual(p.children[3].children, [{ type: "text", value: "src/a.ts" }]);
  assert.deepEqual(p.children[4].children, [{ type: "text", value: "lib/b.ts" }]);
  assert.deepEqual(p.children[5], { type: "text", value: " ok" });
  assert.deepEqual(pre.children, [{ type: "text", value: "x/y.ts" }]);
});
