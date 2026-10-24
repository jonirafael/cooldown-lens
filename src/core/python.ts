import { parse as parseToml } from "smol-toml";
import type { Analysis, PackageTimes } from "./versions";
import { compareRaw, exactPin, maxVersion, parseSpecifiers, parseVersion, satisfies, SpecifierSet, specMentionsPrerelease, isPrerelease } from "./pep440";
import { DAY, HOUR, MINUTE } from "./duration";

/** PEP 503 name normalisation. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export interface PythonDependency {
  /** Name as written. */
  name: string;
  normalized: string;
  /** Version specifier as written ("" = any). */
  spec: string;
  section: string;
  /** Offsets into the document text. */
  nameOffset: number;
  nameLength: number;
  specOffset: number;
  specLength: number;
  lineEndOffset: number;
  /** Set when the requirement cannot be checked (URL, path, VCS...). */
  unsupported?: string;
  /** Parsed specifier set (undefined when unsupported). */
  specifiers?: SpecifierSet;
  /** Spec flavour: PEP 440 (requirements, PEP 621) or Poetry (tool.poetry). */
  flavor: "pep440" | "poetry";
}

const REQ_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/;

/**
 * Parses one PEP 508 requirement string (without its position). Markers are dropped; a direct URL
 * reference (`name @ https://...`) is reported as unsupported.
 */
export function parseRequirementString(req: string): { name: string; nameIndex: number; spec: string; specIndex: number; unsupported?: string } | undefined {
  const lead = req.length - req.trimStart().length;
  const m = REQ_RE.exec(req.trimStart());
  if (!m) return undefined;
  const name = m[1];
  const restStart = lead + m[0].length - m[3].length;
  let rest = m[3];
  const semi = rest.indexOf(";");
  if (semi >= 0) rest = rest.slice(0, semi);
  const trimmedLead = rest.length - rest.trimStart().length;
  const spec = rest.trim();
  const specIndex = restStart + trimmedLead;
  if (spec.startsWith("@")) return { name, nameIndex: lead, spec, specIndex, unsupported: "direct URL reference" };
  return { name, nameIndex: lead, spec, specIndex };
}

function buildDep(
  base: { name: string; nameIndex: number; spec: string; specIndex: number; unsupported?: string },
  offset: number,
  lineEnd: number,
  section: string,
  flavor: "pep440" | "poetry",
): PythonDependency {
  let spec = base.spec;
  let specIndex = base.specIndex;
  // PEP 508 allows "name (>=1.0)"
  const paren = /^\(\s*(.*?)\s*\)$/.exec(spec);
  if (paren) {
    specIndex += spec.indexOf(paren[1]);
    spec = paren[1];
  }
  const dep: PythonDependency = {
    name: base.name,
    normalized: normalizePyName(base.name),
    spec,
    section,
    nameOffset: offset + base.nameIndex,
    nameLength: base.name.length,
    specOffset: offset + specIndex,
    specLength: spec.length,
    lineEndOffset: lineEnd,
    flavor,
    unsupported: base.unsupported,
  };
  if (!dep.unsupported) {
    dep.specifiers = parseSpecifiers(spec);
    if (!dep.specifiers) dep.unsupported = `unrecognised version specifier "${spec}"`;
  }
  return dep;
}

export interface RequirementsFile {
  deps: PythonDependency[];
  /** Files referenced with -r / --requirement (relative paths as written). */
  includes: string[];
}

/** Parses a pip requirements file (requirements.txt, *.in, constraints.txt). */
export function parseRequirementsTxt(text: string, section = "requirements"): RequirementsFile {
  const deps: PythonDependency[] = [];
  const includes: string[] = [];
  let offset = 0;
  // Join "\"-continued lines; replacing the backslash + newline with spaces keeps every offset valid.
  text = text.replace(/\\\r?\n/g, (m) => " ".repeat(m.length));
  for (const rawLine of text.split("\n")) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    let line = rawLine.replace(/\r$/, "");
    const lineEnd = lineStart + line.length;
    // comments: "#" at start or preceded by whitespace
    const hash = line.search(/(^|\s)#/);
    if (hash >= 0) line = line.slice(0, hash);
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("-")) {
      const inc = /^(?:-r|--requirement)(?:\s+|=)(\S+)/.exec(trimmed);
      if (inc) includes.push(inc[1]);
      continue;
    }
    // per-requirement options (--hash=..., --config-settings) start after whitespace
    const opt = line.search(/\s--?[a-z]/);
    if (opt >= 0) line = line.slice(0, opt);
    if (/^\s*(\.|\/|~|[a-z][a-z0-9+.-]*:\/\/|git\+|hg\+|svn\+|bzr\+)/i.test(line) || /\.(whl|tar\.gz|zip)\s*$/i.test(line)) continue;
    const parsed = parseRequirementString(line);
    if (!parsed) continue;
    deps.push(buildDep(parsed, lineStart, lineEnd, section, "pep440"));
  }
  return { deps, includes };
}

function lineEndAt(text: string, offset: number): number {
  const nl = text.indexOf("\n", offset);
  const end = nl < 0 ? text.length : nl;
  return text[end - 1] === "\r" ? end - 1 : end;
}

/** Finds the first not-yet-used quoted occurrence of `value` and returns the offset of its first character. */
function locateString(text: string, value: string, used: Set<number>): number | undefined {
  for (const q of ['"', "'"]) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(q + value + q, from);
      if (i < 0) break;
      if (!used.has(i + 1)) {
        used.add(i + 1);
        return i + 1;
      }
      from = i + 1;
    }
  }
  return undefined;
}

export interface PyprojectFile {
  deps: PythonDependency[];
  warnings: string[];
  uvExcludeNewer?: unknown;
  uvExcludeNewerPackage?: Record<string, unknown>;
}

/**
 * Reads dependencies from pyproject.toml: PEP 621 `project.dependencies` and
 * `project.optional-dependencies`, PEP 735 `dependency-groups`, and Poetry
 * `tool.poetry.dependencies` / `tool.poetry.group.*.dependencies` / `tool.poetry.dev-dependencies`.
 */
export function parsePyproject(text: string): PyprojectFile {
  const out: PyprojectFile = { deps: [], warnings: [] };
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    out.warnings.push(`pyproject.toml: invalid TOML (${(e as Error).message.split("\n")[0]})`);
    return out;
  }
  const used = new Set<number>();
  const pep508 = (list: unknown, section: string) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== "string") continue;
      const parsed = parseRequirementString(item);
      if (!parsed) continue;
      const at = locateString(text, item, used);
      if (at === undefined) continue;
      out.deps.push(buildDep(parsed, at, lineEndAt(text, at), section, "pep440"));
    }
  };
  const project = doc.project as Record<string, unknown> | undefined;
  if (project && typeof project === "object") {
    pep508(project.dependencies, "project.dependencies");
    const opt = project["optional-dependencies"] as Record<string, unknown> | undefined;
    if (opt && typeof opt === "object") for (const [k, v] of Object.entries(opt)) pep508(v, `optional-dependencies.${k}`);
  }
  const groups = doc["dependency-groups"] as Record<string, unknown> | undefined;
  if (groups && typeof groups === "object") for (const [k, v] of Object.entries(groups)) pep508(v, `dependency-groups.${k}`);

  const tool = (doc.tool ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const poetry = tool.poetry;
  if (poetry && typeof poetry === "object") {
    const tables: Array<[string, unknown]> = [["tool.poetry.dependencies", poetry.dependencies], ["tool.poetry.dev-dependencies", poetry["dev-dependencies"]]];
    const pg = poetry.group as Record<string, { dependencies?: unknown }> | undefined;
    if (pg && typeof pg === "object") for (const [g, v] of Object.entries(pg)) tables.push([`tool.poetry.group.${g}`, v?.dependencies]);
    for (const [section, table] of tables) {
      if (!table || typeof table !== "object") continue;
      for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
        if (name.toLowerCase() === "python") continue;
        let spec: string | undefined;
        let unsupported: string | undefined;
        if (typeof value === "string") spec = value;
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          const v = value as Record<string, unknown>;
          if (typeof v.version === "string") spec = v.version;
          else if (v.git || v.path || v.url) unsupported = "git/path/url dependency";
          else spec = "*";
        } else unsupported = "multiple-constraints dependency";
        // locate `name = ` at line start
        const re = new RegExp(`^[ \\t]*["']?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[ \\t]*=`, "gm");
        let m: RegExpExecArray | null;
        let at: number | undefined;
        while ((m = re.exec(text))) {
          const idx = m.index + m[0].indexOf(name);
          if (!used.has(idx)) {
            used.add(idx);
            at = idx;
            break;
          }
        }
        if (at === undefined) continue;
        const lineEnd = lineEndAt(text, at);
        let specIndex = at - at;
        if (spec !== undefined) {
          const rel = text.slice(at, lineEnd).indexOf(spec === "*" && typeof value !== "string" ? "{" : spec);
          specIndex = rel >= 0 ? rel : 0;
        }
        out.deps.push(
          buildDep({ name, nameIndex: 0, spec: spec ?? "", specIndex, unsupported }, at, lineEnd, section, "poetry"),
        );
        const last = out.deps[out.deps.length - 1];
        if (spec === "*" && typeof value !== "string") {
          last.spec = "";
          last.specLength = 0;
          last.specifiers = [[]];
        }
      }
    }
  }
  const uv = tool.uv;
  if (uv && typeof uv === "object") {
    if (uv["exclude-newer"] !== undefined) out.uvExcludeNewer = uv["exclude-newer"];
    const pkg = uv["exclude-newer-package"];
    if (pkg && typeof pkg === "object") out.uvExcludeNewerPackage = pkg as Record<string, unknown>;
  }
  return out;
}

/** Reads `exclude-newer` / `exclude-newer-package` from a uv.toml (top-level keys). */
export function parseUvToml(text: string): { excludeNewer?: unknown; excludeNewerPackage?: Record<string, unknown>; warning?: string } {
  try {
    const doc = parseToml(text) as Record<string, unknown>;
    const pkg = doc["exclude-newer-package"];
    return {
      excludeNewer: doc["exclude-newer"],
      excludeNewerPackage: pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>) : undefined,
    };
  } catch (e) {
    return { warning: `uv.toml: invalid TOML (${(e as Error).message.split("\n")[0]})` };
  }
}

// ----------------------------------------------------------------- uv exclude-newer

const FRIENDLY_UNITS: Array<[RegExp, number]> = [
  [/^(w|wk|wks|week|weeks)$/i, 7 * DAY],
  [/^(d|day|days)$/i, DAY],
  [/^(h|hr|hrs|hour|hours)$/i, HOUR],
  [/^(m|min|mins|minute|minutes)$/i, MINUTE],
  [/^(s|sec|secs|second|seconds)$/i, 1000],
];

/**
 * Parses uv's `exclude-newer` value. uv (>= 0.9.17) accepts a "friendly" duration ("7 days",
 * "1 week", "24 hours"), an ISO 8601 duration ("P7D", "PT24H") or an absolute RFC 3339 timestamp /
 * date. Returns the effective cooldown in ms at `now` (for absolute dates: now - cutoff).
 */
export function parseUvExcludeNewer(value: unknown, now: number): { ms: number; kind: "relative" | "absolute" } | undefined {
  if (value instanceof Date) return { ms: Math.max(0, now - value.getTime()), kind: "absolute" };
  if (value && typeof value === "object" && typeof (value as { toISOString?: unknown }).toISOString === "function") {
    const d = new Date((value as { toISOString(): string }).toISOString());
    if (!Number.isNaN(d.getTime())) return { ms: Math.max(0, now - d.getTime()), kind: "absolute" };
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  const iso = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (iso && s.length > 1 && !/T$/i.test(s)) {
    const [w, d, h, m, sec] = iso.slice(1).map((x) => (x ? Number(x) : 0));
    return { ms: w * 7 * DAY + d * DAY + h * HOUR + m * MINUTE + sec * 1000, kind: "relative" };
  }
  const friendly = s.replace(/\s+ago$/i, "");
  const parts = [...friendly.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)\s*,?\s*/gi)];
  if (parts.length && parts.map((p) => p[0]).join("").trim() === friendly.trim()) {
    let total = 0;
    for (const p of parts) {
      const unit = FRIENDLY_UNITS.find(([re]) => re.test(p[2]));
      if (!unit) return undefined;
      total += Number(p[1]) * unit[1];
    }
    return { ms: total, kind: "relative" };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
    if (!Number.isNaN(d.getTime())) return { ms: Math.max(0, now - d.getTime()), kind: "absolute" };
  }
  return undefined;
}

// ----------------------------------------------------------------------- PyPI JSON

/**
 * Converts a PyPI JSON API document (`/pypi/<name>/json`) into release times: the earliest file
 * upload per release. Releases without files are dropped; fully yanked releases are reported via
 * `deprecated`.
 */
export function extractPypiTimes(doc: unknown): PackageTimes {
  if (!doc || typeof doc !== "object") throw new Error("unexpected PyPI response");
  const d = doc as { info?: { version?: unknown }; releases?: Record<string, Array<{ upload_time_iso_8601?: unknown; upload_time?: unknown; yanked?: unknown }>> };
  const time: Record<string, string> = {};
  const deprecated: string[] = [];
  for (const [version, files] of Object.entries(d.releases ?? {})) {
    if (!Array.isArray(files) || files.length === 0) continue;
    let earliest: number | undefined;
    let allYanked = true;
    for (const f of files) {
      const raw = typeof f.upload_time_iso_8601 === "string" ? f.upload_time_iso_8601 : typeof f.upload_time === "string" ? `${f.upload_time}Z` : undefined;
      const t = raw ? Date.parse(raw) : NaN;
      if (!Number.isNaN(t) && (earliest === undefined || t < earliest)) earliest = t;
      if (!f.yanked) allYanked = false;
    }
    time[version] = earliest !== undefined ? new Date(earliest).toISOString() : "";
    if (allYanked) deprecated.push(version);
  }
  const distTags: Record<string, string> = {};
  if (typeof d.info?.version === "string") distTags.latest = d.info.version;
  return { time, distTags, deprecated };
}

export function pypiJsonUrl(base: URL, name: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) throw new Error(`invalid Python package name "${name}"`);
  return new URL(`pypi/${encodeURIComponent(normalizePyName(name))}/json`, base).toString();
}

// ------------------------------------------------------------------------- analysis

function publishedAt(times: PackageTimes, v: string): Date | undefined {
  const t = times.time[v];
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Same contract as `analyze()` for npm, using PEP 440 ordering and specifiers. */
export function analyzePython(set: SpecifierSet, times: PackageTimes, thresholdMs: number, now: number, installed?: string): Analysis {
  const versions = Object.keys(times.time).filter((v) => parseVersion(v));
  const yanked = new Set(times.deprecated ?? []);
  const isOldEnough = (v: string): boolean => {
    const d = publishedAt(times, v);
    return !!d && now - d.getTime() >= thresholdMs;
  };
  const allowPre = specMentionsPrerelease(set);
  const pin = exactPin(set);
  let candidates = versions.filter((v) => !yanked.has(v) && satisfies(v, set, allowPre));
  // pip falls back to pre-releases when nothing else matches
  if (!candidates.length && !allowPre) candidates = versions.filter((v) => !yanked.has(v) && satisfies(v, set, true));
  let resolved = maxVersion(candidates);
  if (!resolved && pin) resolved = versions.find((v) => compareRaw(v, pin) === 0); // pinned yanked release
  const target = installed ?? resolved;
  const result: Analysis = {
    target,
    targetKind: installed ? "installed" : resolved ? "resolved" : "none",
    resolved,
    installed,
    inCooldown: false,
    missingTime: false,
    freshInRange: 0,
    latest: times.distTags.latest,
  };
  const ageOf = (v?: string) => {
    const d = v ? publishedAt(times, v) : undefined;
    return d ? now - d.getTime() : undefined;
  };
  result.latestAgeMs = ageOf(result.latest);
  if (!target) return result;
  const published = publishedAt(times, target);
  if (!published) result.missingTime = true;
  else {
    result.targetPublished = published;
    result.targetAgeMs = now - published.getTime();
    result.inCooldown = thresholdMs > 0 && result.targetAgeMs < thresholdMs;
    if (result.inCooldown) result.remainingMs = thresholdMs - result.targetAgeMs;
  }
  result.freshInRange = candidates.filter((v) => !isOldEnough(v)).length;
  result.safeInRange = maxVersion(candidates.filter(isOldEnough));
  result.safeInRangeAgeMs = ageOf(result.safeInRange);
  const tv = parseVersion(target);
  const targetIsPre = !!tv && isPrerelease(tv);
  const safeAny = versions.filter((v) => {
    if (yanked.has(v) || !isOldEnough(v) || compareRaw(v, target) > 0) return false;
    const pv = parseVersion(v)!;
    return targetIsPre || !isPrerelease(pv);
  });
  result.safeOutsideRange = maxVersion(safeAny);
  if (result.inCooldown || result.missingTime) {
    if (result.safeInRange && result.safeInRange !== target) {
      result.suggestion = result.safeInRange;
      result.suggestionInRange = true;
    } else if (result.safeOutsideRange && result.safeOutsideRange !== target) {
      result.suggestion = result.safeOutsideRange;
      result.suggestionInRange = false;
    }
    result.suggestionAgeMs = ageOf(result.suggestion);
  }
  return result;
}

/** Text that replaces the specifier for a quick fix ("==1.2.3" or Poetry "1.2.3"). */
export function pythonPinSpec(dep: Pick<PythonDependency, "flavor">, version: string): string {
  return dep.flavor === "poetry" ? version : `==${version}`;
}

// -------------------------------------------------------------------- file helpers

const PY_SKIP_DIRS = /[\\/](\.venv|venv|\.tox|\.nox|site-packages|node_modules)[\\/]/;

/** requirements.txt, requirements-dev.txt, dev-requirements.txt, requirements/*.txt, constraints.txt, *.in, pyproject.toml */
export function isPythonManifestPath(fsPath: string): boolean {
  if (PY_SKIP_DIRS.test(fsPath)) return false;
  const parts = fsPath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  if (base === "pyproject.toml") return true;
  if (/^(.*[-_.])?(requirements|constraints)([-_.].*)?\.(txt|in)$/i.test(base)) return true;
  return /\.(txt|in)$/i.test(base) && (parts[parts.length - 2] ?? "").toLowerCase() === "requirements";
}

/**
 * Reads uv.lock or poetry.lock: normalized name -> locked version, registry packages only
 * (git / path / URL sources are skipped).
 */
export function parsePythonLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  // PEP 751 pylock.toml: [[packages]] with vcs/directory/archive for non-index sources.
  if (Array.isArray(doc.packages)) {
    for (const p of doc.packages as Array<Record<string, unknown>>) {
      if (typeof p.name !== "string" || typeof p.version !== "string") continue;
      if ("vcs" in p || "directory" in p || "archive" in p) continue;
      out.set(normalizePyName(p.name), p.version);
    }
  }
  const pkgs = Array.isArray(doc.package) ? (doc.package as Array<Record<string, unknown>>) : [];
  for (const p of pkgs) {
    if (typeof p.name !== "string" || typeof p.version !== "string") continue;
    const src = p.source as Record<string, unknown> | undefined;
    if (src && typeof src === "object") {
      // uv: { registry = "..." } | { git | path | directory | editable | virtual | url = ... }
      // poetry: { type = "git" | "directory" | "file" | "url" | "legacy", ... }
      if ("git" in src || "path" in src || "directory" in src || "editable" in src || "virtual" in src || "url" in src && !("registry" in src) && !("type" in src)) continue;
      if (typeof src.type === "string" && src.type !== "legacy") continue;
    }
    out.set(normalizePyName(p.name), p.version);
  }
  return out;
}
