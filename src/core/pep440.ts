/**
 * Small PEP 440 implementation: version parsing/ordering and version specifiers
 * (==, !=, <=, >=, <, >, ~=, ===, wildcards). Also understands Poetry constraints (^, ~, *, bare
 * versions, `||`). Good enough to pick the version pip/uv would resolve for a single requirement.
 */
export interface Pep440Version {
  epoch: number;
  release: number[];
  pre?: [number, number]; // [a=0|b=1|rc=2, n]
  post?: number;
  dev?: number;
  local?: string;
  raw: string;
}

const VERSION_RE =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

const PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parseVersion(raw: string): Pep440Version | undefined {
  const m = VERSION_RE.exec(raw);
  if (!m) return undefined;
  const v: Pep440Version = { epoch: m[1] ? Number(m[1]) : 0, release: m[2].split(".").map(Number), raw };
  if (m[3]) v.pre = [PRE_RANK[m[3].toLowerCase()], m[4] ? Number(m[4]) : 0];
  if (m[5] !== undefined) v.post = Number(m[5]);
  else if (m[6]) v.post = m[7] ? Number(m[7]) : 0;
  if (m[8]) v.dev = m[9] ? Number(m[9]) : 0;
  if (m[10]) v.local = m[10].toLowerCase();
  return v;
}

export function isPrerelease(v: Pep440Version): boolean {
  return v.pre !== undefined || v.dev !== undefined;
}

function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

export function compareVersions(a: Pep440Version, b: Pep440Version): number {
  if (a.epoch !== b.epoch) return sign(a.epoch - b.epoch);
  const r = cmpRelease(a.release, b.release);
  if (r) return r;
  // pre-release key: dev-only releases sort before pre-releases; finals after.
  const preKey = (v: Pep440Version): number[] =>
    v.pre ? [1, v.pre[0], v.pre[1]] : v.post === undefined && v.dev !== undefined ? [0, 0, 0] : [2, 0, 0];
  const pa = preKey(a);
  const pb = preKey(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return sign(pa[i] - pb[i]);
  const post = (v: Pep440Version) => (v.post === undefined ? -1 : v.post);
  if (post(a) !== post(b)) return sign(post(a) - post(b));
  const dev = (v: Pep440Version) => (v.dev === undefined ? Infinity : v.dev);
  if (dev(a) !== dev(b)) return dev(a) < dev(b) ? -1 : 1;
  return 0;
}

export function compareRaw(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  return compareVersions(pa, pb);
}

// ---------------------------------------------------------------------------- specifiers

export interface Clause {
  op: "==" | "!=" | "<=" | ">=" | "<" | ">" | "~=" | "===";
  version: string;
}

/** A specifier set is an OR of AND-groups (PEP 440 only has one group; Poetry allows `||`). */
export type SpecifierSet = Clause[][];

const CLAUSE_RE = /^\s*(===|==|!=|<=|>=|~=|<|>)\s*([^\s,;]+)\s*$/;

function bump(release: number[], index: number): string {
  const r = release.slice(0, index + 1);
  r[index] = (r[index] ?? 0) + 1;
  return r.join(".");
}

/** Converts one Poetry/PEP 440 constraint token into clauses. Returns undefined when not understood. */
function parseConstraint(token: string): Clause[] | undefined {
  const t = token.trim();
  if (!t || t === "*") return [];
  const m = CLAUSE_RE.exec(t);
  if (m) {
    const version = m[2];
    if (!(version.endsWith(".*") ? parseVersion(version.slice(0, -2)) : parseVersion(version)) && m[1] !== "===") return undefined;
    return [{ op: m[1] as Clause["op"], version }];
  }
  if (t.startsWith("^")) {
    const v = parseVersion(t.slice(1));
    if (!v) return undefined;
    let idx = v.release.findIndex((x) => x !== 0);
    if (idx < 0) idx = v.release.length - 1;
    return [
      { op: ">=", version: t.slice(1) },
      { op: "<", version: bump(v.release, idx) },
    ];
  }
  if (t.startsWith("~") && !t.startsWith("~=")) {
    const v = parseVersion(t.slice(1));
    if (!v) return undefined;
    const idx = v.release.length >= 2 ? 1 : 0;
    return [
      { op: ">=", version: t.slice(1) },
      { op: "<", version: bump(v.release, idx) },
    ];
  }
  if (/^\d[\w.!+-]*\*?$/.test(t)) {
    if (t.endsWith(".*")) return parseVersion(t.slice(0, -2)) ? [{ op: "==", version: t }] : undefined;
    return parseVersion(t) ? [{ op: "==", version: t }] : undefined;
  }
  return undefined;
}

/** Parses "PEP 440" (">=1.0,<2") or Poetry ("^1.2", "~1.2 || ^2", ">=1 <2") specifiers. */
export function parseSpecifiers(spec: string): SpecifierSet | undefined {
  const s = spec.trim().replace(/^\((.*)\)$/, "$1");
  if (!s) return [[]];
  const groups: SpecifierSet = [];
  for (const group of s.split("||")) {
    const clauses: Clause[] = [];
    // split on commas, and on whitespace between complete constraints (Poetry style ">=1 <2")
    const tokens = group
      .split(",")
      .flatMap((p) => p.trim().replace(/(===|==|!=|<=|>=|~=|<|>)\s+/g, "$1").split(/\s+/))
      .filter(Boolean);
    for (const tok of tokens) {
      const c = parseConstraint(tok);
      if (!c) return undefined;
      clauses.push(...c);
    }
    groups.push(clauses);
  }
  return groups;
}

function releasePrefixMatch(v: Pep440Version, prefix: Pep440Version): boolean {
  if (v.epoch !== prefix.epoch) return false;
  for (let i = 0; i < prefix.release.length; i++) if ((v.release[i] ?? 0) !== prefix.release[i]) return false;
  return true;
}

function clauseMatches(c: Clause, v: Pep440Version): boolean {
  if (c.op === "===") return v.raw.trim().toLowerCase() === c.version.toLowerCase();
  if ((c.op === "==" || c.op === "!=") && c.version.endsWith(".*")) {
    const p = parseVersion(c.version.slice(0, -2));
    if (!p) return false;
    const hit = releasePrefixMatch(v, p);
    return c.op === "==" ? hit : !hit;
  }
  const t = parseVersion(c.version);
  if (!t) return false;
  // local versions: "==1.0" matches "1.0+local"
  const cmp = compareVersions(t.local ? v : { ...v, local: undefined }, t);
  switch (c.op) {
    case "==":
      return cmp === 0 && (!t.local || t.local === v.local);
    case "!=":
      return cmp !== 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0 && !(isPrerelease(v) && !isPrerelease(t) && cmpRelease(v.release, t.release) === 0 && v.epoch === t.epoch);
    case ">":
      return cmp > 0 && !(v.post !== undefined && t.post === undefined && cmpRelease(v.release, t.release) === 0);
    case "~=": {
      if (t.release.length < 2) return false;
      const prefix: Pep440Version = { epoch: t.epoch, release: t.release.slice(0, -1), raw: "" };
      return cmp >= 0 && releasePrefixMatch(v, prefix);
    }
  }
  return false;
}

export function specMentionsPrerelease(set: SpecifierSet): boolean {
  return set.some((g) => g.some((c) => c.op !== "!=" && !c.version.endsWith(".*") && !!parseVersion(c.version) && isPrerelease(parseVersion(c.version)!)));
}

export function satisfies(version: string, set: SpecifierSet, allowPre = specMentionsPrerelease(set)): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  if (isPrerelease(v) && !allowPre) return false;
  return set.some((g) => g.every((c) => clauseMatches(c, v)));
}

/** The exact version when the set is a single `==X` / `===X` pin (no wildcard), else undefined. */
export function exactPin(set: SpecifierSet): string | undefined {
  if (set.length !== 1 || set[0].length !== 1) return undefined;
  const c = set[0][0];
  return (c.op === "==" || c.op === "===") && !c.version.endsWith(".*") ? c.version : undefined;
}

export function maxVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const v of versions) if (!best || compareRaw(v, best) > 0) best = v;
  return best;
}
