import { DAY } from "./duration";
import type { CooldownSetting, PackageManager, ParsedConfig } from "./configParsers";
import { ExcludeRule, parseExcludeEntry } from "./glob";

export interface DiscoveredConfig {
  manager: PackageManager;
  config: ParsedConfig;
}

export interface PolicyInput {
  /** Configs in priority order (nearest directory first). */
  discovered: DiscoveredConfig[];
  detectedManager?: PackageManager;
  detectedBy?: string;
  thresholdSource: "auto" | "setting";
  defaultDays: number;
  extraExcludes: string[];
}

export interface CooldownPolicy {
  thresholdMs: number;
  /** "project" when read from package-manager config, "setting" when from the extension setting. */
  kind: "project" | "setting";
  manager?: PackageManager;
  origin: string;
  file?: string;
  excludes: ExcludeRule[];
  notes: string[];
}

export function resolvePolicy(input: PolicyInput): CooldownPolicy {
  const extra = input.extraExcludes
    .map((e) => parseExcludeEntry(e, "cooldownLens.excludePackages"))
    .filter((r): r is ExcludeRule => !!r);
  const notes: string[] = [];
  for (const d of input.discovered) notes.push(...d.config.warnings);

  const fallback = (why: string): CooldownPolicy => ({
    thresholdMs: Math.max(0, input.defaultDays) * DAY,
    kind: "setting",
    origin: `cooldownLens.defaultCooldownDays = ${input.defaultDays} (${why})`,
    excludes: extra,
    notes,
  });

  if (input.thresholdSource === "setting") return fallback("thresholdSource = setting");

  // nearest setting per manager
  const firstSetting = new Map<PackageManager, CooldownSetting>();
  for (const d of input.discovered) {
    if (d.config.setting && !firstSetting.has(d.manager)) firstSetting.set(d.manager, d.config.setting);
  }

  let chosen: CooldownSetting | undefined;
  if (input.detectedManager && firstSetting.has(input.detectedManager)) {
    chosen = firstSetting.get(input.detectedManager);
  } else if (firstSetting.size > 0) {
    // Unknown (or unconfigured) package manager: be conservative and take the strictest value.
    chosen = [...firstSetting.values()].sort((a, b) => b.thresholdMs - a.thresholdMs)[0];
    if (input.detectedManager) {
      notes.push(
        `Project looks like ${input.detectedManager} (${input.detectedBy ?? "detected"}) but has no ${input.detectedManager} cooldown setting; using the strictest other setting found.`,
      );
    } else if (firstSetting.size > 1) {
      notes.push("Several package-manager cooldown settings found and no package manager detected; using the strictest.");
    }
  }

  if (!chosen) {
    if (input.detectedManager === "pnpm") {
      notes.push("pnpm v11+ applies a built-in 1-day minimumReleaseAge when none is configured.");
    } else if (input.detectedManager === "yarn") {
      notes.push("Yarn 4.15+ applies a built-in 1-day npmMinimalAgeGate when none is configured.");
    }
    return fallback("no package-manager cooldown configured");
  }

  const managerExcludes = input.discovered
    .filter((d) => d.manager === chosen!.manager)
    .flatMap((d) => d.config.excludes);

  return {
    thresholdMs: chosen.thresholdMs,
    kind: "project",
    manager: chosen.manager,
    origin: chosen.origin,
    file: chosen.file,
    excludes: [...managerExcludes, ...extra],
    notes,
  };
}

export interface PythonPolicyInput {
  /** uv exclude-newer found in project files. */
  project?: { thresholdMs: number; origin: string; file: string };
  projectExcludes: ExcludeRule[];
  projectWarnings: string[];
  thresholdSource: "auto" | "setting";
  /** cooldownLens.python.minimumReleaseAgeDays (null/undefined = use defaultDays). */
  pythonDays?: number | null;
  defaultDays: number;
  extraExcludes: string[];
}

/** Python counterpart of resolvePolicy(): uv exclude-newer > python setting > default setting. */
export function resolvePythonPolicy(input: PythonPolicyInput): CooldownPolicy {
  const extra = input.extraExcludes
    .map((e) => parseExcludeEntry(e, "cooldownLens.excludePackages"))
    .filter((r): r is ExcludeRule => !!r)
    .map((r) => ({ ...r, name: r.name.toLowerCase().replace(/[-_.]+/g, "-") }));
  const notes = [...input.projectWarnings];
  const hasPySetting = typeof input.pythonDays === "number" && input.pythonDays >= 0;
  const fallback = (why: string): CooldownPolicy => ({
    thresholdMs: Math.max(0, hasPySetting ? input.pythonDays! : input.defaultDays) * DAY,
    kind: "setting",
    origin: hasPySetting
      ? `cooldownLens.python.minimumReleaseAgeDays = ${input.pythonDays} (${why})`
      : `cooldownLens.defaultCooldownDays = ${input.defaultDays} (${why})`,
    excludes: extra,
    notes,
  });
  if (input.thresholdSource === "setting") return fallback("thresholdSource = setting");
  if (!input.project) return fallback("no uv exclude-newer configured");
  return {
    thresholdMs: input.project.thresholdMs,
    kind: "project",
    origin: input.project.origin,
    file: input.project.file,
    excludes: [...input.projectExcludes, ...extra],
    notes,
  };
}
