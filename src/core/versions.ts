import * as semver from "semver";
import type { ParsedSpec } from "./spec";

export interface PackageTimes {
  /** version -> ISO publish time */
  time: Record<string, string>;
  distTags: Record<string, string>;
  /** Versions marked deprecated by the registry. */
  deprecated?: string[];
}

export interface Analysis {
  /** Version we evaluated: installed when known, otherwise what the spec resolves to today. */
  target?: string;
  targetKind: "installed" | "resolved" | "none";
  /** What the spec resolves to today without any cooldown (highest satisfying). */
  resolved?: string;
  installed?: string;
  targetPublished?: Date;
  targetAgeMs?: number;
  inCooldown: boolean;
  /** Remaining time until the target leaves the cooldown. */
  remainingMs?: number;
  /** Highest version that satisfies the spec AND is older than the threshold. */
  safeInRange?: string;
  safeInRangeAgeMs?: number;
  /** Age of the suggested version. */
  suggestionAgeMs?: number;
  /** Highest version (any range) that passes the cooldown, not newer than the target. */
  safeOutsideRange?: string;
  /** The suggestion we offer as quick fix (safeInRange preferred, if different from target). */
  suggestion?: string;
  suggestionInRange?: boolean;
  /** No timestamp for the target version (mirror without `time`). */
  missingTime: boolean;
  /** Total number of versions in the range still inside cooldown. */
  freshInRange: number;
  latest?: string;
  latestAgeMs?: number;
}

function publishedAt(times: PackageTimes, v: string): Date | undefined {
  const t = times.time[v];
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function listVersions(times: PackageTimes): string[] {
  return Object.keys(times.time).filter((k) => k !== "created" && k !== "modified" && semver.valid(k));
}

export function analyze(
  spec: ParsedSpec,
  times: PackageTimes,
  thresholdMs: number,
  now: number,
  installed?: string,
): Analysis {
  const versions = listVersions(times);
  const deprecated = new Set(times.deprecated ?? []);
  const isOldEnough = (v: string): boolean => {
    const d = publishedAt(times, v);
    // Missing timestamp: we cannot prove it is old enough -> treat as not passing (fail closed).
    return !!d && now - d.getTime() >= thresholdMs;
  };

  let range = spec.value;
  let resolved: string | undefined;
  if (spec.kind === "tag") {
    resolved = times.distTags[spec.value];
    range = resolved ?? "";
  } else if (spec.kind === "range") {
    // Mirrors npm: prefer the `latest` tag if it satisfies the range, else highest satisfying.
    const latest = times.distTags.latest;
    resolved =
      latest && semver.satisfies(latest, range, { loose: true })
        ? latest
        : semver.maxSatisfying(versions, range, { loose: true }) ?? undefined;
  }

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
  const latestAt = result.latest ? publishedAt(times, result.latest) : undefined;
  if (latestAt) result.latestAgeMs = now - latestAt.getTime();
  if (!target) return result;

  const published = publishedAt(times, target);
  if (!published) {
    result.missingTime = true;
  } else {
    result.targetPublished = published;
    result.targetAgeMs = now - published.getTime();
    result.inCooldown = thresholdMs > 0 && result.targetAgeMs < thresholdMs;
    if (result.inCooldown) result.remainingMs = thresholdMs - result.targetAgeMs;
  }

  const candidates = (spec.kind === "range" ? versions.filter((v) => semver.satisfies(v, range, { loose: true })) : [])
    .filter((v) => !deprecated.has(v));
  result.freshInRange = candidates.filter((v) => !isOldEnough(v)).length;
  const safeRange = semver.maxSatisfying(candidates.filter(isOldEnough), "*", { includePrerelease: true });
  result.safeInRange = safeRange ?? undefined;
  const ageOf = (v?: string) => {
    const d = v ? publishedAt(times, v) : undefined;
    return d ? now - d.getTime() : undefined;
  };
  result.safeInRangeAgeMs = ageOf(result.safeInRange);

  const targetIsPre = !!semver.prerelease(target);
  const safeAny = versions
    .filter((v) => !deprecated.has(v) && isOldEnough(v) && semver.lte(v, target))
    .filter((v) => targetIsPre || !semver.prerelease(v));
  result.safeOutsideRange = semver.maxSatisfying(safeAny, "*", { includePrerelease: true }) ?? undefined;

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
