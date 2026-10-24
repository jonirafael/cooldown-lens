// Bundles the CLI (and the shared Cooldown Lens core it imports from ../src) into one
// dependency-free file: dist/cli.js.
import * as esbuild from "esbuild";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

await esbuild.build({
  entryPoints: [join(here, "src/cli.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: join(here, "dist/cli.js"),
  mainFields: ["module", "main"],
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  minify: false,
  legalComments: "eof",
  logLevel: "info",
});
