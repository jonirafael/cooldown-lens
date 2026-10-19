import * as fs from "fs/promises";
import * as path from "path";
import {
  LOCKFILES,
  PackageManager,
  ParsedConfig,
  managerFromPackageManagerField,
  parseBunfig,
  parseNpmrc,
  parsePackageJsonPnpmField,
  parsePnpmWorkspace,
  parseYarnrc,
} from "./core/configParsers";
import type { DiscoveredConfig } from "./core/policy";

export const WATCHED_FILES = [".npmrc", "pnpm-workspace.yaml", "bunfig.toml", ".yarnrc.yml", ...Object.keys(LOCKFILES)];

export interface ProjectContext {
  discovered: DiscoveredConfig[];
  detectedManager?: PackageManager;
  detectedBy?: string;
  registry?: string;
  scopedRegistries: Record<string, string>;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Directories from `start` up to (and including) `stop`; if `stop` is not an ancestor, up to the fs root. */
export function ancestorDirs(start: string, stop?: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(start);
  const end = stop ? path.resolve(stop) : undefined;
  for (;;) {
    dirs.push(cur);
    if (end && cur === end) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/**
 * Reads project-level cooldown configuration for the package.json at `pkgDir`, walking up to the
 * workspace folder root. Only project files are read; user/global files (~/.npmrc etc.) are not.
 */
export async function discoverProject(pkgDir: string, rootDir: string | undefined, env: Record<string, string | undefined>): Promise<ProjectContext> {
  const ctx: ProjectContext = { discovered: [], scopedRegistries: {} };
  const push = (manager: PackageManager, config: ParsedConfig) => {
    if (config.setting || config.excludes.length || config.warnings.length) ctx.discovered.push({ manager, config });
    if (!ctx.registry && config.registry) ctx.registry = config.registry;
    for (const [s, u] of Object.entries(config.scopedRegistries)) if (!ctx.scopedRegistries[s]) ctx.scopedRegistries[s] = u;
  };

  for (const dir of ancestorDirs(pkgDir, rootDir)) {
    const npmrc = await readText(path.join(dir, ".npmrc"));
    if (npmrc !== undefined) {
      const { npm, pnpm } = parseNpmrc(npmrc, path.join(dir, ".npmrc"), env);
      push("npm", npm);
      push("pnpm", pnpm);
    }
    const pnpmWs = await readText(path.join(dir, "pnpm-workspace.yaml"));
    if (pnpmWs !== undefined) push("pnpm", parsePnpmWorkspace(pnpmWs, path.join(dir, "pnpm-workspace.yaml")));
    const bunfig = await readText(path.join(dir, "bunfig.toml"));
    if (bunfig !== undefined) push("bun", parseBunfig(bunfig, path.join(dir, "bunfig.toml")));
    const yarnrc = await readText(path.join(dir, ".yarnrc.yml"));
    if (yarnrc !== undefined) push("yarn", parseYarnrc(yarnrc, path.join(dir, ".yarnrc.yml"), env));

    const pkgText = await readText(path.join(dir, "package.json"));
    if (pkgText !== undefined) {
      try {
        const pkg = JSON.parse(pkgText);
        push("pnpm", parsePackageJsonPnpmField(pkg, path.join(dir, "package.json")));
        if (!ctx.detectedManager) {
          const pm = managerFromPackageManagerField(pkg);
          if (pm) {
            ctx.detectedManager = pm;
            ctx.detectedBy = `packageManager field in ${path.join(dir, "package.json")}`;
          }
        }
      } catch {
        /* the active document may be mid-edit */
      }
    }
    if (!ctx.detectedManager) {
      for (const [lock, pm] of Object.entries(LOCKFILES)) {
        if (await exists(path.join(dir, lock))) {
          ctx.detectedManager = pm;
          ctx.detectedBy = `${lock} in ${dir}`;
          break;
        }
      }
    }
  }
  return ctx;
}

/** Finds the installed version by walking node_modules up the tree (hoisted layouts). */
export async function findInstalledVersion(pkgDir: string, name: string, rootDir?: string): Promise<string | undefined> {
  for (const dir of ancestorDirs(pkgDir, rootDir)) {
    const text = await readText(path.join(dir, "node_modules", ...name.split("/"), "package.json"));
    if (text === undefined) continue;
    try {
      const v = JSON.parse(text).version;
      if (typeof v === "string") return v;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
