import { describe, expect, it } from "vitest";
import {
  analyzePython,
  extractPypiTimes,
  normalizePyName,
  parsePyproject,
  parseRequirementsTxt,
  parseUvExcludeNewer,
  parseUvToml,
  pypiJsonUrl,
  pythonPinSpec,
} from "../src/core/python";
import { parseSpecifiers } from "../src/core/pep440";
import { resolvePythonPolicy } from "../src/core/policy";
import { DAY, HOUR } from "../src/core/duration";

const NOW = Date.parse("2026-10-24T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("requirements.txt", () => {
  const text = [
    "# comment",
    "requests>=2.31,<3  # http",
    "Django[argon2]==5.1.2 ; python_version >= '3.10'",
    "numpy",
    "-r other.txt",
    "-e git+https://github.com/x/y.git#egg=y",
    "pkg @ https://example.com/pkg.whl",
    "--index-url https://pypi.org/simple",
    "flask \\",
    "  ==3.0.0",
    "",
  ].join("\n");
  const { deps, includes } = parseRequirementsTxt(text);
  it("extracts names, specs and offsets", () => {
    const byName = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(Object.keys(byName)).toEqual(["requests", "Django", "numpy", "flask"]);
    expect(byName.requests.spec).toBe(">=2.31,<3");
    expect(text.slice(byName.requests.specOffset, byName.requests.specOffset + byName.requests.specLength)).toBe(">=2.31,<3");
    expect(byName.Django.spec).toBe("==5.1.2");
    expect(byName.Django.normalized).toBe("django");
    expect(text.slice(byName.Django.nameOffset, byName.Django.nameOffset + byName.Django.nameLength)).toBe("Django");
    expect(byName.numpy.spec).toBe("");
    expect(includes).toContain("other.txt");
  });
  it("handles line continuations", () => {
    const flask = deps.find((d) => d.name === "flask");
    expect(flask?.spec.replace(/\s|\\/g, "")).toBe("==3.0.0");
  });
});

describe("pyproject.toml", () => {
  const text = `
[project]
name = "demo"
dependencies = [
  "httpx>=0.27",
  "pydantic==2.9.2",
]
[project.optional-dependencies]
docs = ["mkdocs~=1.6"]

[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]
lint = ["ruff"]

[tool.poetry.dependencies]
python = "^3.11"
rich = "^13.7"
typer = { version = "~0.12", extras = ["all"] }
local = { path = "../local" }

[tool.poetry.group.test.dependencies]
hypothesis = "*"

[tool.uv]
exclude-newer = "7 days"
exclude-newer-package = { internal-lib = false }
`;
  const pp = parsePyproject(text);
  const find = (n: string) => pp.deps.find((d) => d.name === n);
  it("reads PEP 621, PEP 735 and Poetry sections", () => {
    expect(find("httpx")?.section).toBe("project.dependencies");
    expect(find("mkdocs")?.section).toContain("optional-dependencies");
    expect(find("pytest")?.section).toContain("dependency-groups");
    expect(find("ruff")).toBeDefined();
    expect(find("rich")?.flavor).toBe("poetry");
    expect(find("rich")?.spec).toBe("^13.7");
    expect(find("typer")?.spec).toBe("~0.12");
    expect(find("hypothesis")?.section).toContain("test");
    expect(find("python")).toBeUndefined();
    expect(find("local")?.unsupported).toBeTruthy();
  });
  it("offsets point at the spec inside the string", () => {
    const h = find("httpx")!;
    expect(text.slice(h.specOffset, h.specOffset + h.specLength)).toBe(">=0.27");
    const r = find("rich")!;
    expect(text.slice(r.specOffset, r.specOffset + r.specLength)).toBe("^13.7");
  });
  it("exposes uv settings", () => {
    expect(pp.uvExcludeNewer).toBe("7 days");
    expect(pp.uvExcludeNewerPackage).toEqual({ "internal-lib": false });
  });
  it("reports invalid TOML", () => {
    expect(parsePyproject("[project\n").warnings[0]).toMatch(/invalid TOML/);
  });
});

describe("uv exclude-newer", () => {
  it("parses friendly and ISO durations", () => {
    expect(parseUvExcludeNewer("7 days", NOW)).toEqual({ ms: 7 * DAY, kind: "relative" });
    expect(parseUvExcludeNewer("1 week", NOW)?.ms).toBe(7 * DAY);
    expect(parseUvExcludeNewer("24 hours", NOW)?.ms).toBe(24 * HOUR);
    expect(parseUvExcludeNewer("P3D", NOW)?.ms).toBe(3 * DAY);
    expect(parseUvExcludeNewer("PT12H", NOW)?.ms).toBe(12 * HOUR);
  });
  it("parses absolute cutoffs", () => {
    expect(parseUvExcludeNewer("2026-10-20T00:00:00Z", NOW)).toEqual({ ms: 4 * DAY, kind: "absolute" });
    expect(parseUvExcludeNewer("2026-10-14", NOW)?.ms).toBe(10 * DAY);
  });
  it("rejects garbage", () => {
    expect(parseUvExcludeNewer("soon", NOW)).toBeUndefined();
    expect(parseUvExcludeNewer(42, NOW)).toBeUndefined();
  });
  it("reads uv.toml", () => {
    expect(parseUvToml('exclude-newer = "P7D"\n').excludeNewer).toBe("P7D");
  });
});

describe("PyPI JSON", () => {
  const doc = {
    info: { version: "2.1.0" },
    releases: {
      "1.0.0": [{ upload_time_iso_8601: ago(400) }],
      "2.0.0": [{ upload_time_iso_8601: ago(30) }, { upload_time_iso_8601: ago(31) }],
      "2.1.0": [{ upload_time_iso_8601: ago(1) }],
      "2.0.1": [{ upload_time_iso_8601: ago(20), yanked: true }],
      "3.0.0a1": [{ upload_time_iso_8601: ago(0.5) }],
      "0.0.1": [],
    },
  };
  const times = extractPypiTimes(doc);
  it("uses the earliest upload and marks yanked releases", () => {
    expect(times.time["2.0.0"]).toBe(ago(31));
    expect(times.time["0.0.1"]).toBeUndefined();
    expect(times.deprecated).toEqual(["2.0.1"]);
    expect(times.distTags.latest).toBe("2.1.0");
  });
  it("flags a too-young resolution and suggests the newest safe version", () => {
    const a = analyzePython(parseSpecifiers(">=1.0")!, times, 7 * DAY, NOW);
    expect(a.target).toBe("2.1.0");
    expect(a.inCooldown).toBe(true);
    expect(a.suggestion).toBe("2.0.0");
    expect(a.suggestionInRange).toBe(true);
  });
  it("passes an old pin and suggests outside the range for a fresh pin", () => {
    expect(analyzePython(parseSpecifiers("==1.0.0")!, times, 7 * DAY, NOW).inCooldown).toBe(false);
    const a = analyzePython(parseSpecifiers("==2.1.0")!, times, 7 * DAY, NOW);
    expect(a.inCooldown).toBe(true);
    expect(a.suggestion).toBe("2.0.0");
    expect(a.suggestionInRange).toBe(false);
  });
  it("builds safe URLs", () => {
    expect(pypiJsonUrl(new URL("https://pypi.org/"), "Django_Rest.Framework")).toBe("https://pypi.org/pypi/django-rest-framework/json");
    expect(() => pypiJsonUrl(new URL("https://pypi.org/"), "../etc")).toThrow();
  });
  it("normalizes names and pins", () => {
    expect(normalizePyName("Foo__Bar.baz")).toBe("foo-bar-baz");
    expect(pythonPinSpec({ flavor: "pep440" }, "1.2")).toBe("==1.2");
    expect(pythonPinSpec({ flavor: "poetry" }, "1.2")).toBe("1.2");
  });
});

describe("python policy", () => {
  const base = { projectExcludes: [], projectWarnings: [], thresholdSource: "auto" as const, defaultDays: 7, extraExcludes: [] };
  it("prefers uv exclude-newer", () => {
    const p = resolvePythonPolicy({ ...base, project: { thresholdMs: 3 * DAY, origin: "uv", file: "/x/uv.toml" }, pythonDays: 14 });
    expect(p.thresholdMs).toBe(3 * DAY);
    expect(p.kind).toBe("project");
  });
  it("falls back to the python setting, then the default", () => {
    expect(resolvePythonPolicy({ ...base, pythonDays: 14 }).thresholdMs).toBe(14 * DAY);
    expect(resolvePythonPolicy({ ...base, pythonDays: null }).thresholdMs).toBe(7 * DAY);
  });
  it("normalizes extra excludes", () => {
    expect(resolvePythonPolicy({ ...base, extraExcludes: ["My_Pkg"] }).excludes[0].name).toBe("my-pkg");
  });
});

describe("parsePythonLock pylock.toml", () => {
  it("reads PEP 751 packages and skips vcs/directory", async () => {
    const { parsePythonLock } = await import("../src/core/python");
    const m = parsePythonLock('lock-version = "1.0"\n[[packages]]\nname = "Requests"\nversion = "2.32.3"\n[[packages]]\nname = "mylib"\nversion = "0.1"\n[packages.directory]\npath = "."\n');
    expect([...m]).toEqual([["requests", "2.32.3"]]);
  });
});
