import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const forbidden = ["aurelia", "lodge", "v2"].join("_");
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const textExtensions = new Set([".html",".js",".mjs",".cjs",".ts",".tsx",".jsx",".json",".yml",".yaml",".sh",".md"]);

function collect(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");
      if (relative === "src/storage" || relative.startsWith("src/storage/") || relative === "www/src/storage" || relative.startsWith("www/src/storage/")) continue;
      collect(path.join(directory, entry.name), files);
    } else if (textExtensions.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

test("legacy snapshot key is confined to src/storage and index.html has no Web Storage access", () => {
  const violations = collect(root).flatMap(file => {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("\\0")) return [];
    return source.includes(forbidden) ? [path.relative(root, file)] : [];
  });
  assert.deepEqual(violations, [], "Legacy snapshot key leaked outside src/storage: " + violations.join(", "));
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.doesNotMatch(html, /\\blocalStorage\\b/, "index.html must not access Web Storage directly");
});
