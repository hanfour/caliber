#!/usr/bin/env node
// Walk apps/{api,web}/src and emit a TSV of every inline literal Zod
// validation message. Output columns:
//   file<TAB>line<TAB>kind<TAB>literal_message<TAB>suggested_key
//
// Three kinds are detected by regex (we deliberately avoid a full TS AST
// parser to keep the script self-contained — false positives are reviewed
// manually before sweep):
//   - inline2:   z.<...>(..., "literal")       e.g. .min(1, "Name is required")
//   - opts:      z.<...>(..., { message: "literal" })  e.g. .max(255, { message: "Too long" })
//   - refine:    .refine(..., { message: "literal", ... }) or .superRefine(...)
//
// Usage: node scripts/audit-zod-i18n.mjs > /tmp/zod-i18n-audit.tsv

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Node 22+ exposes fs.globSync, but this repo runs on Node 20 (see
// apps/api/package.json engines). Use `find` via execSync as a portable
// fallback so the script works on any Node ≥ 18.
const FILES = execSync(
  "find apps/api/src apps/web/src -type f \\( -name '*.ts' -o -name '*.tsx' \\)",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const PATTERNS = [
  // .min(1, "msg"), .max(10, "msg"), .length(N, "msg"), .email("msg"), .uuid("msg"), .url("msg")
  {
    kind: "inline2",
    re: /\.(min|max|length|email|uuid|url|regex|datetime|cuid)\(\s*[^,)]+,\s*"([^"]+)"\s*\)/g,
    msgGroup: 2,
  },
  // .min(1, { message: "msg" })
  {
    kind: "opts",
    re: /\.(min|max|length|email|uuid|url|regex|datetime|cuid|nonempty)\(\s*(?:[^,)]+,\s*)?\{\s*message:\s*"([^"]+)"/g,
    msgGroup: 2,
  },
  // .refine(predicate, { message: "msg", ... })  or  .superRefine(...) with literal in addIssue
  {
    kind: "refine",
    re: /\.(refine|superRefine)\([\s\S]*?\{\s*message:\s*"([^"]+)"/g,
    msgGroup: 2,
  },
  // ctx.addIssue({ ..., message: "literal" })  (inside superRefine / transform)
  {
    kind: "addIssue",
    re: /addIssue\(\s*\{[\s\S]*?message:\s*"([^"]+)"/g,
    msgGroup: 1,
  },
];

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

function areaFromPath(file) {
  if (file.includes("apps/api/src/trpc/routers/")) {
    return file.replace(/^.*routers\/([^/]+)\.ts$/, "$1");
  }
  if (file.includes("apps/web/src/components/")) {
    return file.replace(/^.*components\/([^/]+)\/.*$/, "$1");
  }
  return "shared";
}

console.log(
  ["file", "line", "kind", "literal_message", "suggested_key"].join("\t"),
);
for (const file of FILES) {
  const src = readFileSync(file, "utf8");
  for (const { kind, re, msgGroup } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const upto = src.slice(0, m.index);
      const line = upto.split("\n").length;
      const literal = m[msgGroup];
      const area = areaFromPath(file);
      const key = `validation.custom.${area}.${slugify(literal)}`;
      console.log([file, line, kind, literal, key].join("\t"));
    }
  }
}
