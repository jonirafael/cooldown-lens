import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  // jsonc-parser ships a UMD "main" with dynamic requires that cannot be bundled; use its ESM build.
  mainFields: ["module", "main"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
  legalComments: "linked",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
