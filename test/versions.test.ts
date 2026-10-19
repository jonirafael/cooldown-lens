import { describe, expect, it } from "vitest";
import { analyze, PackageTimes } from "../src/core/versions";
import { parseSpec, rewriteSpec } from "../src/core/spec";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-19T00:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();

const times: PackageTimes = {
  time: {
    created: ago(400),
    modified: ago(0.1),
    "1.0.0": ago(300),
    "1.1.0": ago(100),
    "1.2.0": ago(20),
    "1.2.1": ago(5),
    "1.3.0": ago(1),
    "2.0.0-beta.1": ago(3),
    "2.0.0": ago(0.5),
  },
  distTags: { latest: "2.0.0", next: "2.0.0-beta.1" },
};

const run = (name: string, spec: string, threshold = 7, installed?: string, t = times) =>
  analyze(parseSpec(name, spec), t, threshold * DAY, NOW, installed);

describe("analyze()", () => {
  it("flags a caret range resolving to a fresh version and suggests the newest safe one in range", () => {
    const a = run("pkg", "^1.0.0");
    expect(a.target).toBe("1.3.0");
    expect(a.targetKind).toBe("resolved");
    expect(a.inCooldown).toBe(true);
    expect(a.remainingMs).toBe(6 * DAY);
    expect(a.safeInRange).toBe("1.2.0");
    expect(a.suggestion).toBe("1.2.0");
    expect(a.suggestionInRange).toBe(true);
    expect(a.freshInRange).toBe(2); // 1.2.1, 1.3.0
  });

  it("prefers the latest dist-tag when it satisfies the range (npm behaviour)", () => {
    const a = run("pkg", ">=1.0.0");
    expect(a.resolved).toBe("2.0.0");
    expect(a.inCooldown).toBe(true);
    expect(a.suggestion).toBe("1.2.0");
  });

  it("does not flag versions older than the threshold", () => {
    const a = run("pkg", "~1.1.0");
    expect(a.target).toBe("1.1.0");
    expect(a.inCooldown).toBe(false);
    expect(a.suggestion).toBeUndefined();
  });

  it("uses the installed version when known", () => {
    const a = run("pkg", "^1.0.0", 7, "1.2.0");
    expect(a.targetKind).toBe("installed");
    expect(a.inCooldown).toBe(false);
    expect(a.resolved).toBe("1.3.0");
  });

  it("flags a fresh installed version", () => {
    const a = run("pkg", "^1.0.0", 7, "1.2.1");
    expect(a.inCooldown).toBe(true);
    expect(a.suggestion).toBe("1.2.0");
  });

  it("suggests a version outside the range when nothing in range is old enough", () => {
    const a = run("pkg", "^2.0.0");
    expect(a.target).toBe("2.0.0");
    expect(a.safeInRange).toBeUndefined();
    expect(a.suggestion).toBe("1.2.0");
    expect(a.suggestionInRange).toBe(false);
  });

  it("handles exact pins", () => {
    const a = run("pkg", "1.2.1");
    expect(a.inCooldown).toBe(true);
    expect(a.safeInRange).toBeUndefined();
    expect(a.suggestion).toBe("1.2.0");
    expect(a.suggestionInRange).toBe(false);
  });

  it("resolves dist-tags", () => {
    const a = run("pkg", "next");
    expect(a.target).toBe("2.0.0-beta.1");
    expect(a.inCooldown).toBe(true);
    // prerelease targets may be replaced by older prereleases or stable versions
    expect(a.suggestion).toBe("1.2.0");
  });

  it("does not suggest prereleases for stable targets", () => {
    const t: PackageTimes = {
      time: { "1.0.0": ago(30), "1.1.0-rc.1": ago(20), "1.1.0": ago(1) },
      distTags: { latest: "1.1.0" },
    };
    expect(run("p", "1.1.0", 7, undefined, t).suggestion).toBe("1.0.0");
  });

  it("threshold 0 disables the cooldown", () => {
    expect(run("pkg", "^1.0.0", 0).inCooldown).toBe(false);
  });

  it("treats missing timestamps as unverifiable (fail closed)", () => {
    const t: PackageTimes = { time: { "1.0.0": ago(30), "1.1.0": "" }, distTags: { latest: "1.1.0" } };
    const a = run("p", "^1.0.0", 7, undefined, t);
    expect(a.missingTime).toBe(true);
    expect(a.suggestion).toBe("1.0.0");
  });

  it("skips deprecated versions when suggesting", () => {
    const t: PackageTimes = { ...times, deprecated: ["1.2.0"] };
    expect(run("pkg", "^1.0.0", 7, undefined, t).suggestion).toBe("1.1.0");
  });

  it("returns no target when nothing satisfies", () => {
    const a = run("pkg", "^9.0.0");
    expect(a.target).toBeUndefined();
    expect(a.targetKind).toBe("none");
  });

  it("supports npm: aliases", () => {
    const spec = parseSpec("my-alias", "npm:real-pkg@^1.0.0");
    expect(spec.registryName).toBe("real-pkg");
    expect(analyze(spec, times, 7 * DAY, NOW).suggestion).toBe("1.2.0");
  });
});

describe("parseSpec()", () => {
  it.each([
    ["^1.2.3", "range"],
    ["~1.2", "range"],
    [">=1 <3", "range"],
    ["1.x || 2.x", "range"],
    ["*", "range"],
    ["", "range"],
    ["latest", "tag"],
    ["next", "tag"],
    ["workspace:^", "unsupported"],
    ["file:../x", "unsupported"],
    ["link:../x", "unsupported"],
    ["catalog:", "unsupported"],
    ["github:user/repo", "unsupported"],
    ["user/repo", "unsupported"],
    ["git+https://github.com/a/b.git", "unsupported"],
    ["https://example.com/x.tgz", "unsupported"],
  ])("%s -> %s", (spec, kind) => {
    expect(parseSpec("x", spec).kind).toBe(kind);
  });
});

describe("rewriteSpec()", () => {
  it.each([
    ["^1.3.0", "1.2.0", "^1.2.0"],
    ["~1.3.0", "1.2.0", "~1.2.0"],
    ["1.3.0", "1.2.0", "1.2.0"],
    [">=1.3.0", "1.2.0", ">=1.2.0"],
    ["=1.3.0", "1.2.0", "1.2.0"],
    ["latest", "1.2.0", "^1.2.0"],
    ["1.x || 2.x", "1.2.0", "1.2.0"],
  ])("%s with %s -> %s", (spec, v, out) => {
    expect(rewriteSpec(spec, v, "x", "x")).toBe(out);
  });

  it("keeps npm: alias prefixes", () => {
    expect(rewriteSpec("npm:real-pkg@^1.3.0", "1.2.0", "real-pkg", "alias")).toBe("npm:real-pkg@^1.2.0");
  });
});

describe("pinSpec()", () => {
  it("pins exactly and keeps aliases", async () => {
    const { pinSpec } = await import("../src/core/spec");
    expect(pinSpec("^1.3.0", "1.2.0", "x", "x")).toBe("1.2.0");
    expect(pinSpec("npm:real@^1", "1.2.0", "real", "alias")).toBe("npm:real@1.2.0");
  });
});

describe("ages of suggestions", () => {
  it("reports the age of the safe version", () => {
    const a = run("pkg", "^1.0.0");
    expect(a.safeInRangeAgeMs).toBe(20 * DAY);
    expect(a.suggestionAgeMs).toBe(20 * DAY);
  });
});
