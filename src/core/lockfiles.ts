import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import * as semver from "semver";
import type { PackageManager } from "./configParsers";

/**
 * Lockfile readers shared by the VS Code extension and the `cooldown-check` CLI. They only extract
 * (registry name, version) pairs; integrity, tarball URLs and the dependency graph are ignored.
 */
export interface LockedPackage {
  /** Name on the registry (the real name for npm: aliases). */
  name: string;
  version: string;
  /** Listed as a direct dependency of the root project / importer. */
  direct: boolean;
}

export interface LockfileResult {
  file: string;
  manager: PackageManager;
  /** Unique by name@version. */
  packages: LockedPackage[];
  /** package.json key -> locked version for direct dependencies of the root project. */
  direct: Record<string, { name: string; version: string }>;
  warnings: string[];
}

function result(file: string, manager: PackageManager): LockfileResult {
  return { file, manager, packages: [], direct: {}, warnings: [] };
}

function finish(r: LockfileResult, all: Map<string, LockedPackage>): LockfileResult {
  const directKeys = new Set(Object.values(r.direct).map((d) => `${d.name}@${d.version}`));
  for (const p of all.values()) p.direct = directKeys.has(`${p.name}@${p.version}`);
  r.packages = [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version, true));
  return r;
}

function add(all: Map<string, LockedPackage>, name: string, version: string): void {
  if (!name || !semver.valid(version, { loose: true })) return;
  const key = `${name}@${version}`;
  if (!all.has(key)) all.set(key, { name, version, direct: false });
}

/** Splits "name@version" / "@scope/name@version". */
export function splitNameVersion(s: string): { name: string; version: string } | undefined {
  const at = s.indexOf("@", s.startsWith("@") ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

// ----------------------------------------------------------------- package-lock.json

export function parsePackageLock(text: string, file = "package-lock.json"): LockfileResult {
  const r = result(file, "npm");
  const all = new Map<string, LockedPackage>();
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    r.warnings.push(`${file}: invalid JSON (${(e as Error).message})`);
    return r;
  }
  const packages = doc.packages as Record<string, { version?: string; name?: string; link?: boolean; resolved?: string }> | undefined;
  if (packages && typeof packages === "object") {
    const root = (packages[""] ?? {}) as Record<string, Record<string, string> | undefined>;
    const rootDeps = new Set(
      ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((s) => Object.keys(root[s] ?? {})),
    );
    for (const [key, entry] of Object.entries(packages)) {
      if (!key || !entry || typeof entry !== "object" || entry.link) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx < 0) continue; // workspace package
      const keyName = key.slice(idx + "node_modules/".length);
      if (typeof entry.version !== "string") continue;
      const res = entry.resolved;
      if (res && (/^(file:|git\+|git:|github:)/.test(res) || (/^https?:/.test(res) && !res.includes("/-/")))) continue;
      const name = typeof entry.name === "string" ? entry.name : keyName;
      add(all, name, entry.version);
      if (key === `node_modules/${keyName}` && rootDeps.has(keyName) && semver.valid(entry.version, { loose: true })) {
        r.direct[keyName] = { name, version: entry.version };
      }
    }
  } else if (doc.dependencies && typeof doc.dependencies === "object") {
    // lockfileVersion 1: nested tree
    const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>, top: boolean) => {
      for (const [keyName, d] of Object.entries(deps)) {
        if (!d || typeof d.version !== "string") continue;
        let name = keyName;
        let version = d.version;
        if (version.startsWith("npm:")) {
          const nv = splitNameVersion(version.slice(4));
          if (!nv) continue;
          ({ name, version } = nv);
        }
        add(all, name, version);
        if (top && semver.valid(version, { loose: true })) r.direct[keyName] = { name, version };
        if (d.dependencies && typeof d.dependencies === "object") walk(d.dependencies as never, false);
      }
    };
    walk(doc.dependencies as never, true);
  }
  return finish(r, all);
}

// ------------------------------------------------------------------- pnpm-lock.yaml

/** Parses pnpm package keys: "/foo/1.0.0" (v5), "/foo@1.0.0(peer@2)" (v6), "foo@1.0.0(peer@2)" (v9). */
export function parsePnpmKey(key: string): { name: string; version: string } | undefined {
  let k = key.startsWith("/") ? key.slice(1) : key;
  const paren = k.indexOf("(");
  if (paren > 0) k = k.slice(0, paren);
  const nv = splitNameVersion(k);
  if (nv && semver.valid(nv.version.split("_")[0], { loose: true })) return { name: nv.name, version: nv.version.split("_")[0] };
  // v5: name/version
  const slash = k.lastIndexOf("/");
  if (slash > 0) {
    const name = k.slice(0, slash);
    const version = k.slice(slash + 1).split("_")[0];
    if (semver.valid(version, { loose: true })) return { name, version };
  }
  return undefined;
}

export function parsePnpmLock(text: string, file = "pnpm-lock.yaml", importer = "."): LockfileResult {
  const r = result(file, "pnpm");
  const all = new Map<string, LockedPackage>();
  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(text, { maxAliasCount: -1 }) ?? {}) as Record<string, unknown>;
  } catch (e) {
    r.warnings.push(`${file}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    return r;
  }
  const pkgs = { ...((doc.packages as object) ?? {}), ...((doc.snapshots as object) ?? {}) } as Record<string, unknown>;
  for (const key of Object.keys(pkgs)) {
    const nv = parsePnpmKey(key);
    if (nv) add(all, nv.name, nv.version);
  }
  const importers = doc.importers as Record<string, Record<string, unknown>> | undefined;
  const imp = importers?.[importer] ?? (importers ? undefined : doc);
  if (imp) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = imp[section] as Record<string, unknown> | undefined;
      if (!deps || typeof deps !== "object") continue;
      for (const [keyName, v] of Object.entries(deps)) {
        let ver = typeof v === "string" ? v : v && typeof v === "object" ? String((v as { version?: unknown }).version ?? "") : "";
        if (!ver || ver.startsWith("link:") || ver.startsWith("file:")) continue;
        ver = ver.replace(/^\//, "");
        const paren = ver.indexOf("(");
        if (paren > 0) ver = ver.slice(0, paren);
        ver = ver.split("_")[0];
        let name = keyName;
        if (!semver.valid(ver, { loose: true })) {
          const nv = parsePnpmKey(ver); // alias: "real-name@1.0.0" or "/real-name/1.0.0"
          if (!nv) continue;
          ({ name, version: ver } = nv);
        }
        r.direct[keyName] = { name, version: ver };
        add(all, name, ver);
      }
    }
  }
  return finish(r, all);
}

// ------------------------------------------------------------------------- yarn.lock

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

/** Handles both Yarn classic (v1) and Yarn Berry (YAML-ish) lockfiles. */
export function parseYarnLock(text: string, file = "yarn.lock", rootDeps: Record<string, string> = {}): LockfileResult {
  const r = result(file, "yarn");
  const all = new Map<string, LockedPackage>();
  const descriptorTo = new Map<string, { name: string; version: string }>();
  let descriptors: string[] = [];
  let version: string | undefined;
  let resolution: string | undefined;
  const flush = () => {
    if (descriptors.length && version) {
      let name: string | undefined;
      let ok = true;
      if (resolution) {
        // berry: "name@npm:1.2.3" — only npm-protocol resolutions come from the registry
        const nv = splitNameVersion(resolution);
        if (!nv || !nv.version.startsWith("npm:")) ok = false;
        else name = nv.name;
      } else {
        const first = descriptors[0];
        const nv = splitNameVersion(first);
        if (nv?.version.startsWith("npm:")) name = splitNameVersion(nv.version.slice(4))?.name ?? nv.version.slice(4);
        else name = nv?.name;
        if (nv && /^(file:|link:|git|github:|https?:|workspace:|portal:|patch:)/.test(nv.version)) ok = false;
      }
      if (ok && name && semver.valid(version, { loose: true })) {
        add(all, name, version);
        for (const d of descriptors) descriptorTo.set(d, { name, version });
      }
    }
    descriptors = [];
    version = undefined;
    resolution = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      flush();
      const header = raw.replace(/:\s*$/, "");
      if (header === "__metadata") continue;
      descriptors = header.split(/,\s*/).map(unquote).filter(Boolean);
      continue;
    }
    const m = /^\s{2}(version|resolution):?\s+(.+)$/.exec(raw);
    if (m) {
      if (m[1] === "version") version = unquote(m[2]);
      else resolution = unquote(m[2]);
    }
  }
  flush();
  for (const [keyName, spec] of Object.entries(rootDeps)) {
    const hit =
      descriptorTo.get(`${keyName}@${spec}`) ??
      descriptorTo.get(`${keyName}@npm:${spec}`) ??
      (spec.startsWith("npm:") ? descriptorTo.get(`${keyName}@${spec}`) : undefined);
    if (hit) r.direct[keyName] = hit;
  }
  return finish(r, all);
}

// --------------------------------------------------------------------------- bun.lock

export function parseBunLock(text: string, file = "bun.lock"): LockfileResult {
  const r = result(file, "bun");
  const all = new Map<string, LockedPackage>();
  const errors: { error: number }[] = [];
  const doc = parseJsonc(text, errors as never, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== "object") {
    r.warnings.push(`${file}: could not parse`);
    return r;
  }
  const rootWs = ((doc.workspaces as Record<string, Record<string, unknown>> | undefined) ?? {})[""] ?? {};
  const rootDeps = new Set(
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((s) => Object.keys((rootWs[s] as object) ?? {})),
  );
  const packages = (doc.packages ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const nv = splitNameVersion(value[0]);
    if (!nv) continue;
    let { name, version } = nv;
    if (version.startsWith("npm:")) {
      const inner = splitNameVersion(version.slice(4));
      if (inner) ({ name, version } = inner);
      else version = version.slice(4);
    }
    if (!semver.valid(version, { loose: true })) continue; // workspace:, git, file, tarball
    add(all, name, version);
    if (rootDeps.has(key)) r.direct[key] = { name, version };
  }
  return finish(r, all);
}

export const LOCKFILE_READERS: Array<{ file: string; manager: PackageManager }> = [
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
];

export function parseLockfile(fileName: string, text: string, rootDeps: Record<string, string> = {}): LockfileResult | undefined {
  const base = fileName.split(/[\\/]/).pop();
  switch (base) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return parsePackageLock(text, fileName);
    case "pnpm-lock.yaml":
      return parsePnpmLock(text, fileName);
    case "yarn.lock":
      return parseYarnLock(text, fileName, rootDeps);
    case "bun.lock":
      return parseBunLock(text, fileName);
    default:
      return undefined;
  }
}
