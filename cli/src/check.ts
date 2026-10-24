import * as fs from "fs/promises";
import * as path from "path";
import * as semver from "semver";
import { analyze, Analysis, PackageTimes } from "../../src/core/versions";
import { DAY, formatThreshold } from "../../src/core/duration";
import { ExcludeRule, findExclusion, parseExcludeEntry } from "../../src/core/glob";
import { CooldownPolicy, resolvePolicy, resolvePythonPolicy } from "../../src/core/policy";
import { checkRegistryUrl, DEFAULT_REGISTRY, registryFor, RegistryChoice } from "../../src/core/registryUrl";
import { parseSpec, ParsedSpec } from "../../src/core/spec";
import { LOCKFILE_READERS, LockfileResult, parseLockfile, parsePnpmLock } from "../../src/core/lockfiles";
import {
  analyzePython,
  isPythonManifestPath,
  normalizePyName,
  parsePyproject,
  parsePythonLock,
  parseRequirementsTxt,
  PythonDependency,
} from "../../src/core/python";
import { parseSpecifiers } from "../../src/core/pep440";
import { discoverProject, discoverPythonProject } from "../../src/discovery";
import type { Ecosystem } from "../../src/registryClient";
import type { CliOptions } from "./args";

export type Status = "ok" | "too-young" | "no-publish-time" | "excluded" | "skipped" | "error" | "no-match";

export interface Row {
  ecosystem: Ecosystem;
  name: string;
  /** Specifier as written in the manifest (absent for transitive packages). */
  spec?: string;
  version?: string;
  /** Where the version came from. */
  versionSource?: "lockfile" | "resolved";
  direct: boolean;
  manifest?: string;
  section?: string;
  status: Status;
  publishedAt?: string;
  ageMs?: number;
  thresholdMs: number;
  remainingMs?: number;
  /** Newest version older than the cooldown (in range when possible). */
  safeVersion?: string;
  safeVersionInRange?: boolean;
  message?: string;
}

export interface EcosystemReport {
  policy: { thresholdMs: number; threshold: string; source: string; file?: string; notes: string[] };
  registry: string;
  manifests: string[];
  lockfile?: string;
}

export interface Report {
  directory: string;
  generatedAt: string;
  npm?: EcosystemReport;
  python?: EcosystemReport;
  results: Row[];
  summary: { checked: number; tooYoung: number; noPublishTime: number; errors: number; skipped: number; excluded: number };
  warnings: string[];
}

export type FetchTimes = (ecosystem: Ecosystem, registry: string, name: string) => Promise<PackageTimes>;

const ALLOW_INSECURE = ["localhost", "127.0.0.1", "[::1]"];

async function readText(file: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 50 * 1024 * 1024) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Nearest ancestor (including `dir`) that contains `.git`, used as the config-discovery boundary. */
async function findRepoRoot(dir: string): Promise<string | undefined> {
  let cur = path.resolve(dir);
  for (;;) {
    if (await exists(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function fromAnalysis(row: Row, a: Analysis, excludedBy: ExcludeRule | undefined): Row {
  row.version = a.target;
  if (!a.target) {
    row.status = "no-match";
    row.message = "no published version matches the specifier";
    return row;
  }
  row.publishedAt = a.targetPublished?.toISOString();
  row.ageMs = a.targetAgeMs;
  row.remainingMs = a.remainingMs;
  if (excludedBy) {
    row.status = "excluded";
    row.message = `excluded by ${excludedBy.name} (${excludedBy.source})`;
  } else if (a.missingTime) row.status = "no-publish-time";
  else row.status = a.inCooldown ? "too-young" : "ok";
  if (row.status === "too-young" || row.status === "no-publish-time") {
    row.safeVersion = a.suggestion;
    row.safeVersionInRange = a.suggestionInRange;
  }
  return row;
}

function overridePolicy(policy: CooldownPolicy, opts: CliOptions, label: string): CooldownPolicy {
  const extra = opts.excludes.map((e) => parseExcludeEntry(e, "--exclude")).filter((r): r is ExcludeRule => !!r);
  if (opts.minAgeMs !== undefined) {
    return { ...policy, thresholdMs: opts.minAgeMs, kind: "setting", origin: `--min-age (${formatThreshold(opts.minAgeMs)})`, file: undefined, excludes: [...policy.excludes, ...extra] };
  }
  if (policy.kind === "setting") {
    return { ...policy, origin: `default ${formatThreshold(opts.defaultMinAgeMs)} (no ${label} cooldown configured; set one or pass --min-age)`, excludes: [...policy.excludes, ...extra] };
  }
  return { ...policy, excludes: [...policy.excludes, ...extra] };
}

function ecoReport(policy: CooldownPolicy, registry: string, manifests: string[], lockfile?: string): EcosystemReport {
  return {
    policy: { thresholdMs: policy.thresholdMs, threshold: formatThreshold(policy.thresholdMs), source: policy.origin, file: policy.file, notes: policy.notes },
    registry,
    manifests,
    lockfile,
  };
}

// ---------------------------------------------------------------------------- npm

async function findLockfile(dir: string, stop: string | undefined): Promise<{ file: string; text: string; dir: string } | undefined> {
  let cur = path.resolve(dir);
  const end = stop ? path.resolve(stop) : undefined;
  for (;;) {
    for (const { file } of LOCKFILE_READERS) {
      const p = path.join(cur, file);
      const text = await readText(p);
      if (text !== undefined) return { file: p, text, dir: cur };
    }
    if (end && cur === end) return undefined;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

async function checkNpm(dir: string, stop: string | undefined, opts: CliOptions, fetchTimes: FetchTimes, now: number, report: Report): Promise<Promise<void>[]> {
  const pkgFile = path.join(dir, "package.json");
  const text = await readText(pkgFile);
  if (text === undefined) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    report.warnings.push(`${pkgFile}: invalid JSON (${(e as Error).message})`);
    return [];
  }
  const project = await discoverProject(dir, stop, process.env);
  const policy = overridePolicy(
    resolvePolicy({
      discovered: project.discovered,
      detectedManager: project.detectedManager,
      detectedBy: project.detectedBy,
      thresholdSource: "auto",
      defaultDays: opts.defaultMinAgeMs / DAY,
      extraExcludes: [],
    }),
    opts,
    "npm/pnpm/yarn/bun",
  );
  const pick = (raw: string | undefined, label: string): string | undefined => {
    if (!raw) return undefined;
    const c = checkRegistryUrl(raw, ALLOW_INSECURE);
    if (c.ok) return c.url.toString();
    report.warnings.push(`ignored ${label} registry: ${c.reason}`);
    return undefined;
  };
  const scoped: Record<string, string> = {};
  for (const [s, u] of Object.entries(project.scopedRegistries)) {
    const v = pick(u, `${s} scoped`);
    if (v) scoped[s] = v;
  }
  const registry: RegistryChoice = { base: pick(opts.registry, "--registry") ?? pick(project.registry, "project") ?? DEFAULT_REGISTRY, scoped };
  if (opts.registry && !pick(opts.registry, "--registry")) throw new Error(`invalid --registry URL`);

  const sections = ["dependencies", "optionalDependencies", "peerDependencies", ...(opts.prod ? [] : ["devDependencies"])];
  const rootDeps: Record<string, string> = {};
  const entries: Array<{ key: string; spec: string; section: string }> = [];
  for (const section of sections) {
    const obj = pkg[section];
    if (!obj || typeof obj !== "object") continue;
    for (const [key, spec] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      if (section === "peerDependencies" && (pkg.dependencies as Record<string, unknown> | undefined)?.[key] !== undefined) continue;
      if (section === "peerDependencies" && (pkg.devDependencies as Record<string, unknown> | undefined)?.[key] !== undefined) continue;
      rootDeps[key] = spec;
      entries.push({ key, spec, section });
    }
  }

  const lockHit = await findLockfile(dir, stop);
  let lock: LockfileResult | undefined;
  if (lockHit) {
    const rel = path.relative(lockHit.dir, dir).split(path.sep).join("/") || ".";
    lock = path.basename(lockHit.file) === "pnpm-lock.yaml" ? parsePnpmLock(lockHit.text, lockHit.file, rel) : parseLockfile(lockHit.file, lockHit.text, rootDeps);
    if (lock) report.warnings.push(...lock.warnings);
    if (lock && lockHit.dir !== path.resolve(dir) && path.basename(lockHit.file) !== "pnpm-lock.yaml") lock.direct = {};
  }
  report.npm = ecoReport(policy, registry.base, [pkgFile], lockHit?.file);

  const locked = (registryName: string, spec: ParsedSpec): string | undefined => {
    if (!lock || spec.kind !== "range") return undefined;
    const candidates = lock.packages.filter((p) => p.name === registryName && semver.satisfies(p.version, spec.value, { loose: true, includePrerelease: true }));
    return candidates.map((p) => p.version).sort((a, b) => semver.rcompare(a, b, true))[0];
  };

  const tasks: Promise<void>[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const spec = parseSpec(e.key, e.spec);
    const row: Row = { ecosystem: "npm", name: spec.registryName, spec: e.spec, direct: true, manifest: pkgFile, section: e.section, status: "skipped", thresholdMs: policy.thresholdMs };
    if (e.key !== spec.registryName) row.message = `alias ${e.key}`;
    report.results.push(row);
    if (spec.kind === "unsupported") {
      row.message = spec.reason ?? "not a registry dependency";
      continue;
    }
    const lockedVersion = lock?.direct[e.key]?.version ?? locked(spec.registryName, spec);
    if (lockedVersion) seen.add(`${spec.registryName}@${lockedVersion}`);
    tasks.push(
      (async () => {
        try {
          const times = await fetchTimes("npm", registryFor(spec.registryName, registry), spec.registryName);
          const a = analyze(spec, times, policy.thresholdMs, now, lockedVersion);
          row.versionSource = lockedVersion ? "lockfile" : "resolved";
          fromAnalysis(row, a, findExclusion(policy.excludes, spec.registryName, a.target));
        } catch (err) {
          row.status = "error";
          row.message = (err as Error).message;
        }
      })(),
    );
  }
  if (opts.all && lock) {
    for (const p of lock.packages) {
      const k = `${p.name}@${p.version}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const spec: ParsedSpec = { kind: "range", registryName: p.name, value: p.version };
      const row: Row = { ecosystem: "npm", name: p.name, version: p.version, versionSource: "lockfile", direct: false, status: "skipped", thresholdMs: policy.thresholdMs };
      report.results.push(row);
      tasks.push(
        (async () => {
          try {
            const times = await fetchTimes("npm", registryFor(p.name, registry), p.name);
            const a = analyze(spec, times, policy.thresholdMs, now, p.version);
            fromAnalysis(row, a, findExclusion(policy.excludes, p.name, a.target));
          } catch (err) {
            row.status = "error";
            row.message = (err as Error).message;
          }
        })(),
      );
    }
  } else if (opts.all && !lock) {
    report.warnings.push("--all needs a lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock); only direct dependencies were checked");
  }
  return tasks;
}

// ------------------------------------------------------------------------- Python

const DEV_SECTION = /(^|[.\s-])(dev|test|tests|lint|docs?|typing)([.\s-]|$)|dependency-groups|dev-dependencies/i;

async function checkPython(dir: string, stop: string | undefined, opts: CliOptions, fetchTimes: FetchTimes, now: number, report: Report): Promise<Promise<void>[]> {
  const files: string[] = [];
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const n of names) if (isPythonManifestPath(path.join(dir, n)) && (await readText(path.join(dir, n))) !== undefined) files.push(path.join(dir, n));
  const reqDir = path.join(dir, "requirements");
  for (const n of await fs.readdir(reqDir).catch(() => [] as string[])) if (isPythonManifestPath(path.join(reqDir, n))) files.push(path.join(reqDir, n));
  if (!files.length) return [];
  files.sort();

  const project = await discoverPythonProject(dir, stop, now);
  const policy = overridePolicy(
    resolvePythonPolicy({
      project: project.setting,
      projectExcludes: project.excludes,
      projectWarnings: project.warnings,
      thresholdSource: "auto",
      defaultDays: opts.defaultMinAgeMs / DAY,
      extraExcludes: [],
    }),
    opts,
    "uv exclude-newer",
  );
  let index = "https://pypi.org/";
  if (opts.pypiIndex) {
    const c = checkRegistryUrl(opts.pypiIndex, ALLOW_INSECURE);
    if (!c.ok) throw new Error(`invalid --pypi-index URL: ${c.reason}`);
    index = c.url.toString();
  }
  let lockFile: string | undefined;
  let lockVersions = new Map<string, string>();
  for (const lf of ["uv.lock", "poetry.lock", "pylock.toml"]) {
    const t = await readText(path.join(dir, lf));
    if (t !== undefined) {
      lockFile = path.join(dir, lf);
      lockVersions = parsePythonLock(t);
      break;
    }
  }
  report.python = ecoReport(policy, index, files, lockFile);

  const tasks: Promise<void>[] = [];
  const seen = new Set<string>();
  const check = (dep: PythonDependency, manifest: string) => {
    const isDevFile = /(^|[-_.])(dev|test|tests|lint|docs?)([-_.]|$)/i.test(path.basename(manifest).replace(/\.(txt|in)$/i, ""));
    if (opts.prod && (DEV_SECTION.test(dep.section) || isDevFile)) return;
    const row: Row = { ecosystem: "pypi", name: dep.name, spec: dep.spec || "*", direct: true, manifest, section: dep.section, status: "skipped", thresholdMs: policy.thresholdMs };
    report.results.push(row);
    if (dep.unsupported || !dep.specifiers) {
      row.message = dep.unsupported ?? "unsupported specifier";
      return;
    }
    const lockedVersion = lockVersions.get(dep.normalized);
    if (lockedVersion) seen.add(`${dep.normalized}@${lockedVersion}`);
    const set = dep.specifiers;
    tasks.push(
      (async () => {
        try {
          const times = await fetchTimes("pypi", index, dep.name);
          const a = analyzePython(set, times, policy.thresholdMs, now, lockedVersion);
          row.versionSource = lockedVersion ? "lockfile" : "resolved";
          fromAnalysis(row, a, findExclusion(policy.excludes, dep.normalized, a.target));
        } catch (err) {
          row.status = "error";
          row.message = (err as Error).message;
        }
      })(),
    );
  };
  for (const f of files) {
    const text = (await readText(f)) ?? "";
    if (path.basename(f) === "pyproject.toml") {
      const pp = parsePyproject(text);
      report.warnings.push(...pp.warnings);
      for (const d of pp.deps) check(d, f);
    } else {
      for (const d of parseRequirementsTxt(text).deps) check(d, f);
    }
  }
  if (opts.all && lockVersions.size) {
    for (const [name, version] of lockVersions) {
      if (seen.has(`${name}@${version}`)) continue;
      const row: Row = { ecosystem: "pypi", name, version, versionSource: "lockfile", direct: false, status: "skipped", thresholdMs: policy.thresholdMs };
      report.results.push(row);
      const set = parseSpecifiers(`==${version}`);
      if (!set) continue;
      tasks.push(
        (async () => {
          try {
            const times = await fetchTimes("pypi", index, name);
            const a = analyzePython(set, times, policy.thresholdMs, now, version);
            fromAnalysis(row, a, findExclusion(policy.excludes, normalizePyName(name), a.target));
          } catch (err) {
            row.status = "error";
            row.message = (err as Error).message;
          }
        })(),
      );
    }
  }
  return tasks;
}

// --------------------------------------------------------------------------- entry

export class NothingToCheck extends Error {}

export async function runCheck(opts: CliOptions, fetchTimes: FetchTimes, now = Date.now()): Promise<Report> {
  const dir = path.resolve(opts.dir);
  const st = await fs.stat(dir).catch(() => undefined);
  if (!st?.isDirectory()) throw new NothingToCheck(`${dir} is not a directory`);
  const stop = (await findRepoRoot(dir)) ?? dir;
  const report: Report = {
    directory: dir,
    generatedAt: new Date(now).toISOString(),
    results: [],
    summary: { checked: 0, tooYoung: 0, noPublishTime: 0, errors: 0, skipped: 0, excluded: 0 },
    warnings: [],
  };
  const tasks = [...(await checkNpm(dir, stop, opts, fetchTimes, now, report))];
  if (opts.python) tasks.push(...(await checkPython(dir, stop, opts, fetchTimes, now, report)));
  if (!report.npm && !report.python) {
    throw new NothingToCheck(`no package.json${opts.python ? ", requirements*.txt or pyproject.toml" : ""} found in ${dir}`);
  }
  await Promise.all(tasks);
  if (report.npm) report.npm.policy.notes = [...new Set(report.npm.policy.notes)];
  report.warnings = [...new Set(report.warnings)];
  for (const r of report.results) {
    if (r.status === "skipped") report.summary.skipped++;
    else if (r.status === "error") report.summary.errors++;
    else {
      report.summary.checked++;
      if (r.status === "too-young") report.summary.tooYoung++;
      if (r.status === "no-publish-time") report.summary.noPublishTime++;
      if (r.status === "excluded") report.summary.excluded++;
    }
  }
  return report;
}

/** 0 = clean, 1 = too-young (or missing publish time), 2 = lookups failed and --fail-on-error. */
export function exitCodeFor(report: Report, opts: CliOptions): number {
  if (opts.noFail) return 0;
  if (report.summary.tooYoung || report.summary.noPublishTime) return 1;
  if (opts.failOnError && report.summary.errors) return 2;
  return 0;
}
