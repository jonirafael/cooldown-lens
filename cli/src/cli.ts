import { HELP, parseArgs, UsageError } from "./args";
import { exitCodeFor, FetchTimes, NothingToCheck, runCheck } from "./check";
import { formatReport, jsonReport } from "./format";
import { RegistryClient } from "../../src/registryClient";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs(argv, process.env, !!process.stdout.isTTY);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`cooldown-check: ${e.message}\nRun "cooldown-check --help" for usage.\n`);
      return 2;
    }
    throw e;
  }
  const verbose = argv.includes("--verbose");
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const client = new RegistryClient({
    ttlMs: () => 0,
    offline: () => false,
    timeoutMs: () => opts.timeoutMs,
    concurrency: () => opts.concurrency,
    log: () => undefined,
    userAgent: `cooldown-check/${VERSION}`,
  });
  const fetchTimes: FetchTimes = async (ecosystem, registry, name) => (await client.get(registry, name, false, ecosystem)).data;
  try {
    const report = await runCheck(opts, fetchTimes);
    const code = exitCodeFor(report, opts);
    process.stdout.write((opts.json ? jsonReport(report, code, VERSION) : formatReport(report, { color: opts.color, verbose, all: opts.all })) + "\n");
    return code;
  } catch (e) {
    const msg = (e as Error).message;
    if (opts.json) process.stdout.write(JSON.stringify({ tool: "cooldown-check", version: VERSION, exitCode: 2, error: msg }, null, 2) + "\n");
    else process.stderr.write(`cooldown-check: ${msg}\n`);
    if (!(e instanceof NothingToCheck) && !(e instanceof Error)) throw e;
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`cooldown-check: ${(e as Error).stack ?? e}\n`);
      process.exitCode = 2;
    },
  );
}
