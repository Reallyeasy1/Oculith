// Production build: copy the page and stylesheet into dist/ (what the preview serves).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
console.log("build ok: dist/index.html + dist/styles.css");
