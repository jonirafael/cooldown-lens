import * as semver from "semver";

export type SpecKind = "range" | "tag" | "unsupported";

export interface ParsedSpec {
  kind: SpecKind;
  /** Name to look up in the registry (differs from the key for npm: aliases). */
  registryName: string;
  /** Range or dist-tag (without alias prefix). */
  value: string;
  reason?: string;
}

const UNSUPPORTED_PREFIXES = [
  "file:",
  "link:",
  "workspace:",
  "catalog:",
  "portal:",
  "patch:",
  "exec:",
  "git+",
  "git:",
  "github:",
  "gitlab:",
  "bitbucket:",
  "http:",
  "https:",
  "jsr:",
];

export function parseSpec(name: string, rawSpec: string): ParsedSpec {
  let spec = rawSpec.trim();
  let registryName = name;
  if (spec.startsWith("npm:")) {
    const body = spec.slice(4);
    const at = body.lastIndexOf("@");
    if (at > 0) {
      registryName = body.slice(0, at);
      spec = body.slice(at + 1);
    } else {
      registryName = body;
      spec = "latest";
    }
  }
  if (UNSUPPORTED_PREFIXES.some((p) => spec.startsWith(p)) || spec.includes("/") || spec.startsWith(".")) {
    return { kind: "unsupported", registryName, value: spec, reason: "not a registry version" };
  }
  if (spec === "" || spec === "*" || spec === "x") return { kind: "range", registryName, value: "*" };
  if (semver.validRange(spec, { loose: true })) return { kind: "range", registryName, value: spec };
  if (/^[a-zA-Z][\w.-]*$/.test(spec)) return { kind: "tag", registryName, value: spec };
  return { kind: "unsupported", registryName, value: spec, reason: "unrecognised version specifier" };
}

/**
 * Rewrites a specifier to target `version`, preserving a simple leading operator
 * (^, ~, >=, =, exact) and an npm: alias prefix when present.
 */
export function rewriteSpec(rawSpec: string, version: string, registryName: string, keyName: string): string {
  let spec = rawSpec.trim();
  let aliasPrefix = "";
  if (spec.startsWith("npm:")) {
    aliasPrefix = `npm:${registryName}@`;
    spec = spec.slice(4 + registryName.length + 1);
  } else if (registryName !== keyName) {
    aliasPrefix = `npm:${registryName}@`;
  }
  const m = /^(\^|~|>=|=)?\s*v?\d/.exec(spec);
  const op = m?.[1] && m[1] !== "=" ? m[1] : m ? "" : "^";
  return `${aliasPrefix}${op}${version}`;
}

/** Exact pin to `version`, keeping an npm: alias when present. */
export function pinSpec(rawSpec: string, version: string, registryName: string, keyName: string): string {
  const alias = rawSpec.trim().startsWith("npm:") || registryName !== keyName;
  return alias ? `npm:${registryName}@${version}` : version;
}
