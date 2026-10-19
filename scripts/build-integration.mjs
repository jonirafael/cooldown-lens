import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["test-integration/runTest.ts", "test-integration/suite/index.ts", "test-integration/suite/extension.test.ts"],
  outbase: "test-integration",
  outdir: "out/integration",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode", "mocha", "@vscode/test-electron"],
  logLevel: "info",
});
