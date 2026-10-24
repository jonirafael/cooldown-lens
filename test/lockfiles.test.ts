import { describe, expect, it } from "vitest";
import { parseBunLock, parseLockfile, parsePackageLock, parsePnpmKey, parsePnpmLock, parseYarnLock } from "../src/core/lockfiles";

const names = (r: { packages: { name: string; version: string }[] }) => r.packages.map((p) => `${p.name}@${p.version}`).sort();

describe("package-lock.json", () => {
  it("reads v3 packages, aliases and skips links/git", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { lodash: "^4.17.0", alias: "npm:left-pad@1.3.0", local: "file:../local" } },
        "node_modules/lodash": { version: "4.17.21", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" },
        "node_modules/alias": { name: "left-pad", version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" },
        "node_modules/lodash/node_modules/ms": { version: "2.1.3" },
        "node_modules/local": { resolved: "../local", link: true },
        "node_modules/gitdep": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git#abc" },
      },
    };
    const r = parsePackageLock(JSON.stringify(lock));
    expect(names(r)).toEqual(["left-pad@1.3.0", "lodash@4.17.21", "ms@2.1.3"]);
    expect(r.direct.lodash).toEqual({ name: "lodash", version: "4.17.21" });
    expect(r.direct.alias).toEqual({ name: "left-pad", version: "1.3.0" });
    expect(r.packages.find((p) => p.name === "ms")?.direct).toBe(false);
  });
  it("reads v1 nested dependencies", () => {
    const lock = { lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } };
    expect(names(parsePackageLock(JSON.stringify(lock)))).toEqual(["a@1.0.0", "b@2.0.0"]);
  });
  it("warns on invalid JSON", () => {
    expect(parsePackageLock("{").warnings.length).toBe(1);
  });
});

describe("pnpm-lock.yaml", () => {
  it("parses keys across versions", () => {
    expect(parsePnpmKey("/lodash/4.17.21")).toEqual({ name: "lodash", version: "4.17.21" });
    expect(parsePnpmKey("/@types/node@20.1.0")).toEqual({ name: "@types/node", version: "20.1.0" });
    expect(parsePnpmKey("react-dom@18.2.0(react@18.2.0)")).toEqual({ name: "react-dom", version: "18.2.0" });
  });
  it("reads v9 importers and packages", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.2.0
    devDependencies:
      typescript:
        specifier: ~5.4.0
        version: 5.4.5
packages:
  react@18.2.0:
    resolution: {integrity: sha512-x}
  typescript@5.4.5:
    resolution: {integrity: sha512-y}
  loose-envify@1.4.0:
    resolution: {integrity: sha512-z}
snapshots:
  react@18.2.0:
    dependencies:
      loose-envify: 1.4.0
`;
    const r = parsePnpmLock(text);
    expect(names(r)).toEqual(["loose-envify@1.4.0", "react@18.2.0", "typescript@5.4.5"]);
    expect(r.direct.react.version).toBe("18.2.0");
    expect(r.direct.typescript.version).toBe("5.4.5");
  });
  it("reads v6 top-level dependencies", () => {
    const text = `lockfileVersion: '6.0'
dependencies:
  ms:
    specifier: ^2.1.0
    version: 2.1.3
packages:
  /ms@2.1.3:
    resolution: {integrity: sha512-x}
`;
    const r = parsePnpmLock(text);
    expect(names(r)).toEqual(["ms@2.1.3"]);
    expect(r.direct.ms.version).toBe("2.1.3");
  });
});

describe("yarn.lock", () => {
  it("reads classic lockfiles", () => {
    const text = `# yarn lockfile v1

lodash@^4.17.0, lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"

"@babel/core@^7.0.0":
  version "7.24.0"

local@file:../local:
  version "1.0.0"
`;
    const r = parseYarnLock(text, "yarn.lock", { lodash: "^4.17.0", "@babel/core": "^7.0.0" });
    expect(names(r)).toEqual(["@babel/core@7.24.0", "lodash@4.17.21"]);
    expect(r.direct.lodash.version).toBe("4.17.21");
    expect(r.direct["@babel/core"].version).toBe("7.24.0");
  });
  it("reads berry lockfiles", () => {
    const text = `__metadata:
  version: 8

"ms@npm:^2.1.0, ms@npm:^2.1.3":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"

"my-ws@workspace:.":
  version: 0.0.0-use.local
  resolution: "my-ws@workspace:."
`;
    const r = parseYarnLock(text, "yarn.lock", { ms: "^2.1.0" });
    expect(names(r)).toEqual(["ms@2.1.3"]);
    expect(r.direct.ms.version).toBe("2.1.3");
  });
});

describe("bun.lock", () => {
  it("reads the text lockfile", () => {
    const text = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "zod": "^3.23.0" } } },
  "packages": {
    "zod": ["zod@3.23.8", "", {}, "sha512-x"],
    "alias": ["alias@npm:left-pad@1.3.0", "", {}, "sha512-y"],
    "ws": ["ws@workspace:packages/ws"],
  },
}`;
    const r = parseBunLock(text);
    expect(names(r)).toEqual(["left-pad@1.3.0", "zod@3.23.8"]);
    expect(r.direct.zod.version).toBe("3.23.8");
  });
});

describe("parseLockfile", () => {
  it("dispatches by file name", () => {
    expect(parseLockfile("/x/package-lock.json", "{}")?.manager).toBe("npm");
    expect(parseLockfile("/x/unknown.lock", "")).toBeUndefined();
  });
});
