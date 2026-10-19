/**
 * Minimal glob matcher for package-name patterns used by package-manager exclude lists
 * (e.g. "@myorg/*", "*eslint*", "webpack"). Only `*` and `?` are special. Matching is
 * case-sensitive, like npm package names.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[\\^$+.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface ExcludeRule {
  /** Package name or glob. */
  name: string;
  /** Optional exact versions (e.g. from "pkg@1.0.0 || 1.0.1"). Empty = all versions. */
  versions: string[];
  /** Where the rule came from (for hover text). */
  source: string;
}

/**
 * Parses entries like "webpack", "@myorg/*", "nx@21.6.5", "webpack@4.47.0 || 5.102.1",
 * "typescript@npm:5.4.5" (yarn descriptor).
 */
export function parseExcludeEntry(entry: string, source: string): ExcludeRule | undefined {
  const raw = entry.trim();
  if (!raw) return undefined;
  const at = raw.indexOf("@", raw.startsWith("@") ? 1 : 0);
  if (at <= 0) return { name: raw, versions: [], source };
  const name = raw.slice(0, at);
  let range = raw.slice(at + 1).trim();
  if (range.startsWith("npm:")) range = range.slice(4);
  const versions = range
    .split("||")
    .map((v) => v.trim())
    .filter(Boolean);
  return { name, versions, source };
}

export function findExclusion(
  rules: readonly ExcludeRule[],
  pkg: string,
  version?: string,
): ExcludeRule | undefined {
  return rules.find((r) => {
    if (!globToRegExp(r.name).test(pkg)) return false;
    if (r.versions.length === 0) return true;
    return version !== undefined && r.versions.includes(version);
  });
}
