import { describe, expect, it } from "vitest";
import {
  managerFromPackageManagerField,
  parseBunfig,
  parseNpmrc,
  parsePackageJsonPnpmField,
  parsePnpmWorkspace,
  parseYarnDuration,
  parseYarnrc,
} from "../src/core/configParsers";

const DAY = 86_400_000;
const MIN = 60_000;

describe(".npmrc (npm min-release-age, days)", () => {
  it("reads min-release-age in days", () => {
    const { npm } = parseNpmrc("min-release-age=3\n", "/p/.npmrc");
    expect(npm.setting?.thresholdMs).toBe(3 * DAY);
    expect(npm.setting?.manager).toBe("npm");
  });

  it("tolerates spaces and inline comments like the cooldowns.dev example", () => {
    const { npm } = parseNpmrc("min-release-age = 3 # days\n", "/p/.npmrc");
    expect(npm.setting?.thresholdMs).toBe(3 * DAY);
  });

  it("accepts 0 as an explicit opt-out", () => {
    const { npm } = parseNpmrc("min-release-age=0", "/p/.npmrc");
    expect(npm.setting?.thresholdMs).toBe(0);
  });

  it("ignores comments and unrelated keys", () => {
    const { npm, pnpm } = parseNpmrc("# min-release-age=9\n; x\nsave-exact=true\n", "/p/.npmrc");
    expect(npm.setting).toBeUndefined();
    expect(pnpm.setting).toBeUndefined();
  });

  it("collects min-release-age-exclude[] entries", () => {
    const { npm } = parseNpmrc("min-release-age=7\nmin-release-age-exclude[]=@myorg/*\nmin-release-age-exclude[] = my-internal-pkg\n", "/p/.npmrc");
    expect(npm.excludes.map((e) => e.name)).toEqual(["@myorg/*", "my-internal-pkg"]);
    expect(npm.setting?.excludes).toHaveLength(2);
  });

  it("expands env vars and warns when unset", () => {
    expect(parseNpmrc("min-release-age=${AGE}", "/p/.npmrc", { AGE: "5" }).npm.setting?.thresholdMs).toBe(5 * DAY);
    const r = parseNpmrc("min-release-age=${AGE}", "/p/.npmrc", {});
    expect(r.npm.setting).toBeUndefined();
    expect(r.npm.warnings[0]).toMatch(/AGE/);
  });

  it("warns on non-numeric values", () => {
    const r = parseNpmrc("min-release-age=soon", "/p/.npmrc");
    expect(r.npm.setting).toBeUndefined();
    expect(r.npm.warnings).toHaveLength(1);
  });

  it("reads pnpm v10 minimum-release-age in minutes", () => {
    const { pnpm, npm } = parseNpmrc("minimum-release-age=4320", "/p/.npmrc");
    expect(pnpm.setting?.thresholdMs).toBe(4320 * MIN);
    expect(npm.setting).toBeUndefined();
  });

  it("reads registry and scoped registries", () => {
    const { npm } = parseNpmrc("registry=https://mirror.example.com/npm/\n@corp:registry=https://npm.corp.example.com/\n", "/p/.npmrc");
    expect(npm.registry).toBe("https://mirror.example.com/npm/");
    expect(npm.scopedRegistries["@corp"]).toBe("https://npm.corp.example.com/");
  });
});

describe("pnpm-workspace.yaml (minimumReleaseAge, minutes)", () => {
  it("reads minutes", () => {
    const c = parsePnpmWorkspace("packages:\n  - 'pkgs/*'\nminimumReleaseAge: 1440\n", "/p/pnpm-workspace.yaml");
    expect(c.setting?.thresholdMs).toBe(1440 * MIN);
    expect(c.setting?.manager).toBe("pnpm");
  });

  it("reads excludes including version pins", () => {
    const c = parsePnpmWorkspace(
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - webpack\n  - '@myorg/*'\n  - nx@21.6.5\n  - webpack@4.47.0 || 5.102.1\n",
      "/p/pnpm-workspace.yaml",
    );
    expect(c.excludes.map((e) => [e.name, e.versions])).toEqual([
      ["webpack", []],
      ["@myorg/*", []],
      ["nx", ["21.6.5"]],
      ["webpack", ["4.47.0", "5.102.1"]],
    ]);
  });

  it("has no setting when the key is absent", () => {
    expect(parsePnpmWorkspace("packages: []\n", "/p/x").setting).toBeUndefined();
  });

  it("reports invalid YAML without throwing", () => {
    const c = parsePnpmWorkspace("minimumReleaseAge: [\n", "/p/x");
    expect(c.setting).toBeUndefined();
    expect(c.warnings[0]).toMatch(/invalid YAML/);
  });

  it("ignores registry URLs containing env placeholders (pnpm does too)", () => {
    expect(parsePnpmWorkspace("registry: https://${HOST}/\n", "/p/x").registry).toBeUndefined();
  });
});

describe('package.json "pnpm" field (legacy)', () => {
  it("reads minimumReleaseAge in minutes", () => {
    const c = parsePackageJsonPnpmField({ pnpm: { minimumReleaseAge: 60 } }, "/p/package.json");
    expect(c.setting?.thresholdMs).toBe(60 * MIN);
    expect(c.setting?.origin).toMatch(/legacy/);
  });
  it("ignores packages without the field", () => {
    expect(parsePackageJsonPnpmField({ name: "x" }, "/p/package.json").setting).toBeUndefined();
  });
});

describe("bunfig.toml (install.minimumReleaseAge, seconds)", () => {
  it("reads seconds", () => {
    const c = parseBunfig("[install]\nminimumReleaseAge = 259200 # 3 days\n", "/p/bunfig.toml");
    expect(c.setting?.thresholdMs).toBe(3 * DAY);
    expect(c.setting?.manager).toBe("bun");
  });
  it("reads excludes", () => {
    const c = parseBunfig('[install]\nminimumReleaseAge = 60\nminimumReleaseAgeExcludes = ["@types/bun", "typescript@5.4.5"]\n', "/p/bunfig.toml");
    expect(c.excludes.map((e) => [e.name, e.versions])).toEqual([
      ["@types/bun", []],
      ["typescript", ["5.4.5"]],
    ]);
  });
  it("ignores minimumReleaseAge outside [install]", () => {
    expect(parseBunfig("minimumReleaseAge = 100\n", "/p/bunfig.toml").setting).toBeUndefined();
  });
  it("reads registry as string or table", () => {
    expect(parseBunfig('[install]\nregistry = "https://r.example.com"\n', "/p").registry).toBe("https://r.example.com");
    expect(parseBunfig('[install]\nregistry = { url = "https://r2.example.com", token = "x" }\n', "/p").registry).toBe("https://r2.example.com");
  });
  it("reports invalid TOML", () => {
    expect(parseBunfig("[install\n", "/p").warnings[0]).toMatch(/invalid TOML/);
  });
});

describe(".yarnrc.yml (npmMinimalAgeGate, duration; bare number = minutes)", () => {
  it.each([
    ["3d", 3 * DAY],
    ["1w", 7 * DAY],
    ["12h", 12 * 3_600_000],
    ["90m", 90 * MIN],
    ["30s", 30_000],
    ["1500ms", 1500],
    ["1440", 1440 * MIN],
    [".5d", DAY / 2],
  ])("parses %s", (v, ms) => {
    expect(parseYarnDuration(v)).toBe(ms);
  });

  it("treats YAML numbers as minutes", () => {
    expect(parseYarnrc("npmMinimalAgeGate: 4320\n", "/p/.yarnrc.yml").setting?.thresholdMs).toBe(3 * DAY);
  });

  it("parses the documented example", () => {
    const c = parseYarnrc('npmMinimalAgeGate: "1w"\nnpmPreapprovedPackages:\n  - typescript\n  - "@types/*"\n', "/p/.yarnrc.yml");
    expect(c.setting?.thresholdMs).toBe(7 * DAY);
    expect(c.excludes.map((e) => e.name)).toEqual(["typescript", "@types/*"]);
  });

  it.each(["3 days", "1y", "-1d", "abc"])("rejects %s", (v) => {
    expect(parseYarnDuration(v)).toBeUndefined();
  });

  it("reads npmRegistryServer", () => {
    expect(parseYarnrc('npmRegistryServer: "https://registry.yarnpkg.com"\n', "/p").registry).toBe("https://registry.yarnpkg.com");
  });
});

describe("package manager detection", () => {
  it("reads packageManager field", () => {
    expect(managerFromPackageManagerField({ packageManager: "pnpm@10.18.0+sha512.abc" })).toBe("pnpm");
    expect(managerFromPackageManagerField({ packageManager: "yarn@4.10.3" })).toBe("yarn");
  });
  it("reads devEngines.packageManager", () => {
    expect(managerFromPackageManagerField({ devEngines: { packageManager: { name: "bun" } } })).toBe("bun");
  });
  it("returns undefined for unknown tools", () => {
    expect(managerFromPackageManagerField({ packageManager: "deno@2" })).toBeUndefined();
  });
});
