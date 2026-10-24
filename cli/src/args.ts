import { DAY, HOUR, MINUTE } from "../../src/core/duration";
import { parseUvExcludeNewer } from "../../src/core/python";

export interface CliOptions {
  dir: string;
  minAgeMs?: number;
  defaultMinAgeMs: number;
  json: boolean;
  all: boolean;
  prod: boolean;
  python: boolean;
  registry?: string;
  pypiIndex?: string;
  excludes: string[];
  concurrency: number;
  timeoutMs: number;
  failOnError: boolean;
  noFail: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

/**
 * Parses "7d", "12h", "30m", "90s", "2w", "7" (days), "7 days", "1 week", ISO 8601 "P7D" / "PT12H".
 */
export function parseDuration(raw: string): number | undefined {
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * DAY;
  const short = /^(\d+(?:\.\d+)?)\s*(w|d|h|m|min|s)$/i.exec(s);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2].toLowerCase();
    return n * (unit === "w" ? 7 * DAY : unit === "d" ? DAY : unit === "h" ? HOUR : unit === "s" ? 1000 : MINUTE);
  }
  const parsed = parseUvExcludeNewer(s, Date.now());
  return parsed?.kind === "relative" ? parsed.ms : undefined;
}

export const HELP = `cooldown-check — flag npm and PyPI dependencies that are younger than your supply-chain cooldown

Usage: npx cooldown-check [dir] [options]

Reads package.json + lockfile (package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock,
bun.lock) and requirements*.txt / pyproject.toml, looks up publish dates on the registry and
reports every dependency version that is newer than the cooldown.

The cooldown is read from the project (npm min-release-age in .npmrc, pnpm minimumReleaseAge in
pnpm-workspace.yaml, Yarn npmMinimalAgeGate in .yarnrc.yml, Bun minimumReleaseAge in bunfig.toml,
uv exclude-newer in uv.toml / pyproject.toml) unless --min-age is given.

Options:
  --min-age <dur>       Cooldown to enforce, overrides project config (7d, 48h, 2w, 7, P7D)
  --default-min-age <d> Cooldown when the project configures none (default: 7d)
  --all                 Check every locked package (transitive deps), not only direct deps
  --prod                Skip devDependencies (npm) and dev groups (Python)
  --no-python           Do not check requirements*.txt / pyproject.toml
  --exclude <name>      Exempt a package (repeatable, supports globs: "@myorg/*")
  --registry <url>      npm registry (default: project .npmrc registry or registry.npmjs.org)
  --pypi-index <url>    PyPI JSON API base (default: https://pypi.org/)
  --concurrency <n>     Parallel registry requests (default: 8)
  --timeout <sec>       Request timeout in seconds (default: 20)
  --json                Machine-readable output
  --fail-on-error       Exit 2 when a registry lookup fails (default: report and continue)
  --no-fail             Always exit 0 (report only)
  --verbose             Also list passing transitive packages and skipped entries
  --no-color            Disable colours (also honours NO_COLOR)
  -v, --version         Print version
  -h, --help            Show this help

Exit codes: 0 = all dependencies are older than the cooldown, 1 = at least one is too young
(or has no publish time), 2 = usage error / nothing to check / registry failure with --fail-on-error.

VS Code extension (inline ages in package.json, requirements.txt, pyproject.toml):
https://marketplace.visualstudio.com/items?itemName=jonirafael.cooldown-lens
`;

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env, isTty = false): CliOptions {
  const o: CliOptions = {
    dir: ".",
    defaultMinAgeMs: 7 * DAY,
    json: false,
    all: false,
    prod: false,
    python: true,
    excludes: [],
    concurrency: 8,
    timeoutMs: 20_000,
    failOnError: false,
    noFail: false,
    color: isTty && !env.NO_COLOR && env.TERM !== "dumb",
    help: false,
    version: false,
  };
  let dirSet = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline: string | undefined;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new UsageError(`${a} needs a value`);
      return v;
    };
    const duration = (): number => {
      const v = value();
      const ms = parseDuration(v);
      if (ms === undefined || ms < 0) throw new UsageError(`${a}: cannot parse duration "${v}" (try 7d, 48h, 2w)`);
      return ms;
    };
    const int = (): number => {
      const v = value();
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${a}: expected a positive integer, got "${v}"`);
      return n;
    };
    switch (a) {
      case "--min-age":
      case "--cooldown":
        o.minAgeMs = duration();
        break;
      case "--default-min-age":
        o.defaultMinAgeMs = duration();
        break;
      case "--verbose":
        break;
      case "--json":
        o.json = true;
        break;
      case "--all":
        o.all = true;
        break;
      case "--prod":
      case "--production":
        o.prod = true;
        break;
      case "--no-python":
        o.python = false;
        break;
      case "--exclude":
        o.excludes.push(value());
        break;
      case "--registry":
        o.registry = value();
        break;
      case "--pypi-index":
        o.pypiIndex = value();
        break;
      case "--concurrency":
        o.concurrency = int();
        break;
      case "--timeout":
        o.timeoutMs = int() * 1000;
        break;
      case "--fail-on-error":
        o.failOnError = true;
        break;
      case "--no-fail":
        o.noFail = true;
        break;
      case "--no-color":
        o.color = false;
        break;
      case "--color":
        o.color = true;
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "-v":
      case "--version":
        o.version = true;
        break;
      default:
        if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
        if (dirSet) throw new UsageError(`unexpected argument ${a}`);
        o.dir = a;
        dirSet = true;
    }
  }
  return o;
}
