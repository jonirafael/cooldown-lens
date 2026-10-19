import * as path from "path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 60_000, color: true });
  mocha.addFile(path.join(__dirname, "extension.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
