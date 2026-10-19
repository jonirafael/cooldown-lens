import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { DAY, MINUTE } from "./duration";
import { ExcludeRule, parseExcludeEntry } from "./glob";

/**
 * Package-manager cooldown settings. Every key name and unit below was checked against the
 * official documentation (see README "How the threshold is resolved"):
 *
 * | Tool | File | Key | Unit |
 * |------|------|-----|------|
 * | npm (>= 11.10) | .npmrc | `min-release-age` | days |
 * | npm (>= 11.17) | .npmrc | `min-release-age-exclude[]` | names / minimatch globs |
 * | pnpm (>= 10.16) | pnpm-workspace.yaml | `minimumReleaseAge` | minutes |
 * | pnpm (>= 10.16) | pnpm-workspace.yaml | `minimumReleaseAgeExclude` | names / globs / name@v1 \|\| v2 |
 * | pnpm v10 | .npmrc | `minimum-release-age` | minutes |
 * | Bun (>= 1.3) | bunfig.toml | `[install] minimumReleaseAge` | seconds |
 * | Bun | bunfig.toml | `[install] minimumReleaseAgeExcludes` | names / name@version |
 * | Yarn (>= 4.10) | .yarnrc.yml | `npmMinimalAgeGate` | duration ("3d", "1w"); bare number = minutes |
 * | Yarn | .yarnrc.yml | `npmPreapprovedPackages` | descriptors / globs |
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface CooldownSetting {
  manager: PackageManager;
  /** Cooldown in milliseconds; 0 = explicitly disabled. */
  thresholdMs: number;
  /** Human readable origin, e.g. ".npmrc → min-release-age=3 (days)". */
  origin: string;
  file: string;
  excludes: ExcludeRule[];
  /** Non-fatal parser notes (unresolved env vars, invalid values...). */
  warnings: string[];
}

export interface ParsedConfig {
  setting?: CooldownSetting;
  /** Excludes can exist without a threshold (e.g. pnpm v11 default). */
  excludes: ExcludeRule[];
  /** Registry declared by this file (only honoured in trusted workspaces). */
  registry?: string;
  scopedRegistries: Record<string, string>;
  warnings: string[];
}

function emptyConfig(): ParsedConfig {
  return { excludes: [], scopedRegistries: {}, warnings: [] };
}

/** Parses a non-negative number allowing trailing junk such as inline comments ("3 # days"). */
export function parseLeadingNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(value);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------- .npmrc

interface NpmrcEntry {
  key: string;
  value: string;
  line: number;
}

/** Tiny ini reader that is good enough for .npmrc (key=value, `;`/`#` comments, quoted values). */
export function readNpmrc(text: string): NpmrcEntry[] {
  const out: NpmrcEntry[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) return;
    const eq = line.indexOf("=");
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value, line: i + 1 });
  });
  return out;
}

const ENV_REF = /\$\{([^}]+)\}/g;

function expandEnv(value: string, env: Record<string, string | undefined>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const result = value.replace(ENV_REF, (_m, name: string) => {
    const clean = name.replace(/[?:-].*$/, "");
    const v = env[clean];
    if (v === undefined) missing.push(clean);
    return v ?? "";
  });
  return { value: result, missing };
}

export function parseNpmrc(text: string, file: string, env: Record<string, string | undefined> = {}): {
  npm: ParsedConfig;
  pnpm: ParsedConfig;
} {
  const npm = emptyConfig();
  const pnpm = emptyConfig();
  for (const entry of readNpmrc(text)) {
    const { value, missing } = expandEnv(entry.value, env);
    const key = entry.key.replace(/\[\]$/, "");
    if (key === "min-release-age") {
      if (missing.length) {
        npm.warnings.push(`${file}:${entry.line} references unset env var ${missing.join(", ")}`);
        continue;
      }
      const days = parseLeadingNumber(value);
      if (days === undefined) {
        npm.warnings.push(`${file}:${entry.line} min-release-age="${entry.value}" is not a number of days`);
        continue;
      }
      npm.setting = {
        manager: "npm",
        thresholdMs: days * DAY,
        origin: `.npmrc min-release-age=${days} (days)`,
        file,
        excludes: [],
        warnings: [],
      };
    } else if (key === "min-release-age-exclude") {
      for (const part of value.split(",")) {
        const rule = parseExcludeEntry(part, ".npmrc min-release-age-exclude");
        if (rule) npm.excludes.push({ ...rule, versions: [] }); // npm matches names only
      }
    } else if (key === "minimum-release-age") {
      // pnpm v10 read settings from .npmrc in kebab-case; value is in minutes.
      const minutes = parseLeadingNumber(value);
      if (minutes === undefined || missing.length) {
        pnpm.warnings.push(`${file}:${entry.line} minimum-release-age="${entry.value}" is not a number of minutes`);
        continue;
      }
      pnpm.setting = {
        manager: "pnpm",
        thresholdMs: minutes * MINUTE,
        origin: `.npmrc minimum-release-age=${minutes} (minutes, pnpm v10)`,
        file,
        excludes: [],
        warnings: [],
      };
    } else if (key === "minimum-release-age-exclude") {
      for (const part of value.split(",")) {
        const rule = parseExcludeEntry(part, ".npmrc minimum-release-age-exclude");
        if (rule) pnpm.excludes.push(rule);
      }
    } else if (key === "registry") {
      if (!missing.length) npm.registry = value;
    } else {
      const scoped = /^(@[^:]+):registry$/.exec(key);
      if (scoped && !missing.length) npm.scopedRegistries[scoped[1]] = value;
    }
  }
  pnpm.registry = npm.registry;
  pnpm.scopedRegistries = { ...npm.scopedRegistries };
  for (const c of [npm, pnpm]) if (c.setting) c.setting.excludes = c.excludes;
  return { npm, pnpm };
}

// ------------------------------------------------------------------ pnpm-workspace.yaml

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

export function parsePnpmWorkspace(text: string, file: string): ParsedConfig {
  const cfg = emptyConfig();
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    cfg.warnings.push(`${file}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    return cfg;
  }
  if (!doc || typeof doc !== "object") return cfg;
  const d = doc as Record<string, unknown>;
  cfg.excludes = toStringList(d.minimumReleaseAgeExclude)
    .map((e) => parseExcludeEntry(e, "pnpm-workspace.yaml minimumReleaseAgeExclude"))
    .filter((r): r is ExcludeRule => !!r);
  if (d.minimumReleaseAge !== undefined) {
    const minutes = parseLeadingNumber(d.minimumReleaseAge);
    if (minutes === undefined) {
      cfg.warnings.push(`${file}: minimumReleaseAge must be a number of minutes`);
    } else {
      cfg.setting = {
        manager: "pnpm",
        thresholdMs: minutes * MINUTE,
        origin: `pnpm-workspace.yaml minimumReleaseAge: ${minutes} (minutes)`,
        file,
        excludes: cfg.excludes,
        warnings: [],
      };
    }
  }
  if (typeof d.registry === "string" && !d.registry.includes("${")) cfg.registry = d.registry;
  return cfg;
}

/**
 * Legacy: the `pnpm` field of package.json. Current pnpm docs only document cooldown settings in
 * pnpm-workspace.yaml (and .npmrc for v10); this is read as a low-priority compatibility source.
 */
export function parsePackageJsonPnpmField(pkg: unknown, file: string): ParsedConfig {
  const cfg = emptyConfig();
  if (!pkg || typeof pkg !== "object") return cfg;
  const field = (pkg as Record<string, unknown>).pnpm;
  if (!field || typeof field !== "object") return cfg;
  const f = field as Record<string, unknown>;
  cfg.excludes = toStringList(f.minimumReleaseAgeExclude)
    .map((e) => parseExcludeEntry(e, 'package.json "pnpm.minimumReleaseAgeExclude"'))
    .filter((r): r is ExcludeRule => !!r);
  if (f.minimumReleaseAge !== undefined) {
    const minutes = parseLeadingNumber(f.minimumReleaseAge);
    if (minutes !== undefined) {
      cfg.setting = {
        manager: "pnpm",
        thresholdMs: minutes * MINUTE,
        origin: `package.json "pnpm.minimumReleaseAge": ${minutes} (minutes, legacy location)`,
        file,
        excludes: cfg.excludes,
        warnings: [],
      };
    }
  }
  return cfg;
}

// ------------------------------------------------------------------------- bunfig.toml

export function parseBunfig(text: string, file: string): ParsedConfig {
  const cfg = emptyConfig();
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    cfg.warnings.push(`${file}: invalid TOML (${(e as Error).message.split("\n")[0]})`);
    return cfg;
  }
  const install = doc.install as Record<string, unknown> | undefined;
  if (!install || typeof install !== "object") return cfg;
  cfg.excludes = toStringList(install.minimumReleaseAgeExcludes)
    .map((e) => parseExcludeEntry(e, "bunfig.toml install.minimumReleaseAgeExcludes"))
    .filter((r): r is ExcludeRule => !!r);
  if (install.minimumReleaseAge !== undefined) {
    const seconds = parseLeadingNumber(
      typeof install.minimumReleaseAge === "bigint" ? Number(install.minimumReleaseAge) : install.minimumReleaseAge,
    );
    if (seconds === undefined) {
      cfg.warnings.push(`${file}: install.minimumReleaseAge must be a number of seconds`);
    } else {
      cfg.setting = {
        manager: "bun",
        thresholdMs: seconds * 1000,
        origin: `bunfig.toml [install] minimumReleaseAge = ${seconds} (seconds)`,
        file,
        excludes: cfg.excludes,
        warnings: [],
      };
    }
  }
  const reg = install.registry;
  if (typeof reg === "string") cfg.registry = reg;
  else if (reg && typeof reg === "object" && typeof (reg as { url?: unknown }).url === "string") {
    cfg.registry = (reg as { url: string }).url;
  }
  return cfg;
}

// ------------------------------------------------------------------------- .yarnrc.yml

const YARN_UNITS: Record<string, number> = { ms: 1, s: 1000, m: MINUTE, h: 60 * MINUTE, d: DAY, w: 7 * DAY };

/**
 * Mirrors Yarn's `miscUtils.parseDuration(value, DurationUnit.MINUTES)`:
 * `^(\d*\.?\d+)(ms|s|m|h|d|w)?$`, a bare number is interpreted in minutes.
 */
export function parseYarnDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value * MINUTE : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^(\d*\.?\d+)(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2] ? n * YARN_UNITS[m[2]] : n * MINUTE;
}

export function parseYarnrc(text: string, file: string, env: Record<string, string | undefined> = {}): ParsedConfig {
  const cfg = emptyConfig();
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    cfg.warnings.push(`${file}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    return cfg;
  }
  if (!doc || typeof doc !== "object") return cfg;
  const d = doc as Record<string, unknown>;
  cfg.excludes = toStringList(d.npmPreapprovedPackages)
    .map((e) => parseExcludeEntry(e, ".yarnrc.yml npmPreapprovedPackages"))
    .filter((r): r is ExcludeRule => !!r);
  if (d.npmMinimalAgeGate !== undefined) {
    let raw: unknown = d.npmMinimalAgeGate;
    if (typeof raw === "string" && raw.includes("${")) {
      const exp = expandEnv(raw, env);
      raw = exp.missing.length ? undefined : exp.value;
    }
    const ms = parseYarnDuration(raw);
    if (ms === undefined) {
      cfg.warnings.push(`${file}: npmMinimalAgeGate "${String(d.npmMinimalAgeGate)}" is not a valid Yarn duration`);
    } else {
      cfg.setting = {
        manager: "yarn",
        thresholdMs: ms,
        origin: `.yarnrc.yml npmMinimalAgeGate: ${JSON.stringify(d.npmMinimalAgeGate)}`,
        file,
        excludes: cfg.excludes,
        warnings: [],
      };
    }
  }
  if (typeof d.npmRegistryServer === "string" && !d.npmRegistryServer.includes("${")) {
    cfg.registry = d.npmRegistryServer;
  }
  return cfg;
}

// ------------------------------------------------------------------ manager detection

export function managerFromPackageManagerField(pkg: unknown): PackageManager | undefined {
  if (!pkg || typeof pkg !== "object") return undefined;
  const pm = (pkg as Record<string, unknown>).packageManager;
  if (typeof pm === "string") {
    const name = pm.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  }
  const dev = (pkg as { devEngines?: { packageManager?: { name?: unknown } } }).devEngines?.packageManager;
  const devName = dev && typeof dev === "object" ? dev.name : undefined;
  if (devName === "npm" || devName === "pnpm" || devName === "yarn" || devName === "bun") return devName;
  return undefined;
}

export const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
};
