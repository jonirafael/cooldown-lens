import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/core/policy";
import { parseNpmrc, parsePnpmWorkspace, parseYarnrc } from "../src/core/configParsers";
import { findExclusion } from "../src/core/glob";

const DAY = 86_400_000;
const npm3 = parseNpmrc("min-release-age=3\nmin-release-age-exclude[]=@corp/*", "/p/.npmrc").npm;
const pnpm1 = parsePnpmWorkspace("minimumReleaseAge: 1440\nminimumReleaseAgeExclude: [react]", "/p/pnpm-workspace.yaml");
const yarn14 = parseYarnrc('npmMinimalAgeGate: "2w"', "/p/.yarnrc.yml");

const base = { thresholdSource: "auto" as const, defaultDays: 7, extraExcludes: [] };

describe("resolvePolicy()", () => {
  it("falls back to the extension default when nothing is configured", () => {
    const p = resolvePolicy({ ...base, discovered: [] });
    expect(p.thresholdMs).toBe(7 * DAY);
    expect(p.kind).toBe("setting");
  });

  it("uses the detected package manager's setting", () => {
    const p = resolvePolicy({ ...base, discovered: [{ manager: "npm", config: npm3 }, { manager: "pnpm", config: pnpm1 }], detectedManager: "pnpm" });
    expect(p.thresholdMs).toBe(DAY);
    expect(p.manager).toBe("pnpm");
    expect(p.excludes.map((e) => e.name)).toEqual(["react"]);
  });

  it("uses the strictest setting when the manager is unknown", () => {
    const p = resolvePolicy({ ...base, discovered: [{ manager: "npm", config: npm3 }, { manager: "yarn", config: yarn14 }] });
    expect(p.thresholdMs).toBe(14 * DAY);
    expect(p.manager).toBe("yarn");
    expect(p.notes.join()).toMatch(/strictest/);
  });

  it("nearest config wins for the same manager", () => {
    const near = parseNpmrc("min-release-age=1", "/p/a/.npmrc").npm;
    const p = resolvePolicy({ ...base, discovered: [{ manager: "npm", config: near }, { manager: "npm", config: npm3 }], detectedManager: "npm" });
    expect(p.thresholdMs).toBe(DAY);
  });

  it("thresholdSource=setting ignores project config", () => {
    const p = resolvePolicy({ ...base, thresholdSource: "setting", defaultDays: 2, discovered: [{ manager: "npm", config: npm3 }] });
    expect(p.thresholdMs).toBe(2 * DAY);
  });

  it("merges extension excludes and matches globs", () => {
    const p = resolvePolicy({ ...base, extraExcludes: ["left-pad"], discovered: [{ manager: "npm", config: npm3 }], detectedManager: "npm" });
    expect(findExclusion(p.excludes, "@corp/ui")).toBeDefined();
    expect(findExclusion(p.excludes, "left-pad")).toBeDefined();
    expect(findExclusion(p.excludes, "@other/ui")).toBeUndefined();
  });

  it("notes built-in defaults of pnpm/yarn when no explicit setting exists", () => {
    const p = resolvePolicy({ ...base, discovered: [], detectedManager: "pnpm" });
    expect(p.notes.join()).toMatch(/1-day/);
  });
});

describe("findExclusion() with versions", () => {
  const rules = parsePnpmWorkspace("minimumReleaseAgeExclude: ['nx@21.6.5', 'webpack@4.47.0 || 5.102.1']", "/p").excludes;
  it("matches only the listed versions", () => {
    expect(findExclusion(rules, "nx", "21.6.5")).toBeDefined();
    expect(findExclusion(rules, "nx", "21.6.6")).toBeUndefined();
    expect(findExclusion(rules, "webpack", "5.102.1")).toBeDefined();
  });
});
