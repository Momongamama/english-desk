// Sets every local <script src="file.js?v=..."> in index.html to a hash of that file's contents,
// so browsers (and the service worker) fetch a fresh copy exactly when a file changes.
// Run by .github/workflows/cache-version.yml on every push to main; safe to run by hand: `node scripts/bump-versions.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const page = "index.html";
const html = readFileSync(page, "utf8");
const out = html.replace(/(<script src=")([^"?:]+\.js)\?v=[^"]*(")/g, (_, a, file, z) => {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
  return `${a}${file}?v=${hash}${z}`;
});
if (out !== html) { writeFileSync(page, out); console.log("index.html: versions updated") } else console.log("index.html: versions already current");
