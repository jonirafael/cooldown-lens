import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "../..");
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/integration/suite/index.js"),
    launchArgs: [path.join(root, "test-integration/fixture"), "--disable-extensions", "--disable-workspace-trust", "--disable-gpu"],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
