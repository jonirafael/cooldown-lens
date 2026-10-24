import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs, parseDuration, UsageError } from "../src/args";
import { exitCodeFor, FetchTimes, NothingToCheck, runCheck } from "../src/check";
import { formatReport } from "../src/format";
import type { PackageTimes } from "../../src/core/versions";
import { DAY, HOUR } from "../../src/core/duration";

const NOW = Date.parse("2026-10-24T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const NPM: Record<string, PackageTimes> = {
  "fresh-lib": { time: { "1.0.0": ago(100), "1.1.0": ago(30), "1.2.0": ago(1) }, distTags: { latest: "1.2.0" } },
  "old-lib": { time: { "2.0.0": ago(400) }, distTags: { latest: "2.0.0" } },
  "dep-of-old": { time: { "0.1.0": ago(2), "0.0.9": ago(50) }, distTags: { latest: "0.1.0" } },
  "@scope/pinned": { time: { "3.0.0": ago(0.5), "2.9.0": ago(60) }, distTags: { latest: "3.0.0" } },
};
const PYPI: Record<string, PackageTimes> = {
  requests: { time: { "2.31.0": ago(500), "2.32.0": ago(2) }, distTags: { latest: "2.32.0" } },
  flask: { time: { "3.0.0": ago(300) }, distTags: { latest: "3.0.0" } },
};

const calls: string[] = [];
const fetchTimes: FetchTimes = async (eco, registry, name) => {
  calls.push(`${eco}:${registry}:${name}`);
  const t = (eco === "npm" ? NPM : PYPI)[name];
  if (!t) throw new Error(`${name} not found`);
  return t;
};

let dir: string;
const opts = (extra: string[] = []) => parseArgs([dir, ...extra], {});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cooldown-check-"));
  await fs.mkdir(path.join(dir, ".git"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      dependencies: { "fresh-lib": "^1.0.0", "old-lib": "^2.0.0", local: "file:../x" },
      devDependencies: { "@scope/pinned": "3.0.0" },
    }),
  );
  await fs.writeFile(path.join(dir, ".npmrc"), "min-release-age=3\n");
  await fs.writeFile(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "fresh-lib": "^1.0.0", "old-lib": "^2.0.0" }, devDependencies: { "@scope/pinned": "3.0.0" } },
        "node_modules/fresh-lib": { version: "1.1.0", resolved: "https://registry.npmjs.org/fresh-lib/-/fresh-lib-1.1.0.tgz" },
        "node_modules/old-lib": { version: "2.0.0", resolved: "https://registry.npmjs.org/old-lib/-/old-lib-2.0.0.tgz" },
        "node_modules/dep-of-old": { version: "0.1.0", resolved: "https://registry.npmjs.org/dep-of-old/-/dep-of-old-0.1.0.tgz" },
        "node_modules/@scope/pinned": { version: "3.0.0", resolved: "https://registry.npmjs.org/@scope/pinned/-/pinned-3.0.0.tgz", dev: true },
      },
    }),
  );
  await fs.writeFile(path.join(dir, "requirements.txt"), "requests>=2.0\nflask==3.0.0\n");
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("args", () => {
  it("parses durations", () => {
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("48h")).toBe(48 * HOUR);
    expect(parseDuration("2w")).toBe(14 * DAY);
    expect(parseDuration("3")).toBe(3 * DAY);
    expect(parseDuration("P1D")).toBe(DAY);
    expect(parseDuration("1 week")).toBe(7 * DAY);
    expect(parseDuration("soon")).toBeUndefined();
  });
  it("parses options and rejects unknown ones", () => {
    const o = parseArgs(["--min-age=10d", "--json", "--all", "--exclude", "foo", "sub"], {});
    expect(o).toMatchObject({ minAgeMs: 10 * DAY, json: true, all: true, excludes: ["foo"], dir: "sub" });
    expect(() => parseArgs(["--nope"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--min-age", "x"], {})).toThrow(UsageError);
    expect(parseArgs([], { NO_COLOR: "1" }, true).color).toBe(false);
  });
});

describe("runCheck", () => {
  it("uses lockfile versions and project cooldown", async () => {
    const r = await runCheck(opts(), fetchTimes, NOW);
    expect(r.npm?.policy.source).toContain("min-release-age");
    expect(r.npm?.policy.thresholdMs).toBe(3 * DAY);
    const by = Object.fromEntries(r.results.map((x) => [`${x.ecosystem}:${x.name}`, x]));
    // lockfile pins fresh-lib to 1.1.0 (30 days old) even though ^1.0.0 now resolves to 1.2.0
    expect(by["npm:fresh-lib"]).toMatchObject({ version: "1.1.0", versionSource: "lockfile", status: "ok" });
    expect(by["npm:@scope/pinned"]).toMatchObject({ status: "too-young", safeVersion: "2.9.0", safeVersionInRange: false });
    expect(by["npm:local"].status).toBe("skipped");
    expect(by["pypi:requests"]).toMatchObject({ version: "2.32.0", status: "too-young", safeVersion: "2.31.0", versionSource: "resolved" });
    expect(by["pypi:flask"].status).toBe("ok");
    expect(by["npm:dep-of-old"]).toBeUndefined();
    expect(r.summary.tooYoung).toBe(2);
    expect(exitCodeFor(r, opts())).toBe(1);
    expect(exitCodeFor(r, opts(["--no-fail"]))).toBe(0);
  });
  it("--all includes transitive lockfile packages", async () => {
    const r = await runCheck(opts(["--all"]), fetchTimes, NOW);
    expect(r.results.find((x) => x.name === "dep-of-old")).toMatchObject({ direct: false, status: "too-young" });
  });
  it("--min-age overrides, --exclude exempts, --prod skips dev deps", async () => {
    const r = await runCheck(opts(["--min-age", "1h", "--exclude", "requests", "--prod"]), fetchTimes, NOW);
    expect(r.npm?.policy.source).toContain("--min-age");
    expect(r.results.find((x) => x.name === "@scope/pinned")).toBeUndefined();
    expect(r.results.find((x) => x.name === "requests")?.status).toBe("excluded");
    expect(r.summary.tooYoung).toBe(0);
  });
  it("--no-python skips Python files", async () => {
    const r = await runCheck(opts(["--no-python"]), fetchTimes, NOW);
    expect(r.python).toBeUndefined();
    expect(r.results.every((x) => x.ecosystem === "npm")).toBe(true);
  });
  it("reports registry errors without failing by default", async () => {
    const failing: FetchTimes = async (eco, reg, name) => {
      if (name === "old-lib") throw new Error("boom");
      return fetchTimes(eco, reg, name);
    };
    const r = await runCheck(opts(["--min-age", "1h"]), failing, NOW);
    expect(r.summary.errors).toBe(1);
    expect(exitCodeFor(r, opts(["--min-age", "1h"]))).toBe(0);
    expect(exitCodeFor(r, opts(["--min-age", "1h", "--fail-on-error"]))).toBe(2);
  });
  it("throws when nothing can be checked", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cooldown-empty-"));
    await expect(runCheck(parseArgs([empty], {}), fetchTimes, NOW)).rejects.toBeInstanceOf(NothingToCheck);
    await fs.rm(empty, { recursive: true });
  });
  it("renders a table", async () => {
    const r = await runCheck(opts(), fetchTimes, NOW);
    const text = formatReport(r, { color: false, verbose: false, all: false });
    expect(text).toMatch(/STATUS\s+PACKAGE\s+VERSION/);
    expect(text).toMatch(/too young\s+@scope\/pinned\s+3\.0\.0/);
    expect(text).toContain("npm cooldown: 3 days");
  });
});

describe("other package managers", () => {
  it("reads pnpm minimumReleaseAge, pnpm-lock.yaml and uv exclude-newer", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "cooldown-pnpm-"));
    await fs.mkdir(path.join(d, ".git"));
    await fs.writeFile(path.join(d, "package.json"), JSON.stringify({ dependencies: { "fresh-lib": "^1.0.0" } }));
    await fs.writeFile(path.join(d, "pnpm-workspace.yaml"), "minimumReleaseAge: 2880\n");
    await fs.writeFile(
      path.join(d, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fresh-lib:\n        specifier: ^1.0.0\n        version: 1.2.0\npackages:\n  fresh-lib@1.2.0:\n    resolution: {integrity: sha512-x}\n",
    );
    await fs.writeFile(
      path.join(d, "pyproject.toml"),
      '[project]\nname = "x"\ndependencies = ["requests"]\n[tool.uv]\nexclude-newer = "3 days"\n',
    );
    const o = parseArgs([d], {});
    const r = await runCheck(o, fetchTimes, NOW);
    expect(r.npm?.policy.thresholdMs).toBe(2 * DAY);
    expect(r.results.find((x) => x.name === "fresh-lib")).toMatchObject({ version: "1.2.0", versionSource: "lockfile", status: "too-young", safeVersion: "1.1.0" });
    expect(r.python?.policy.thresholdMs).toBe(3 * DAY);
    expect(r.results.find((x) => x.name === "requests")).toMatchObject({ status: "too-young" });
    await fs.rm(d, { recursive: true });
  });
});
