import * as path from "path";
import { formatAge } from "../../src/core/duration";
import type { Report, Row, Status } from "./check";

const C = { red: 31, green: 32, yellow: 33, gray: 90, bold: 1, cyan: 36 } as const;

function paint(on: boolean) {
  return (code: keyof typeof C, s: string) => (on ? `\u001b[${C[code]}m${s}\u001b[0m` : s);
}

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\u001b\[\d+m/g, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

const ORDER: Record<Status, number> = { "too-young": 0, "no-publish-time": 1, error: 2, "no-match": 3, ok: 4, excluded: 5, skipped: 6 };

export function renderTable(rows: string[][], color: boolean): string {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => visible(r[i] ?? ""))));
  const c = paint(color);
  return rows
    .map((r, idx) => {
      const line = r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]))).join("  ").trimEnd();
      return idx === 0 ? c("bold", line) : line;
    })
    .join("\n");
}

function statusLabel(r: Row, color: boolean): string {
  const c = paint(color);
  switch (r.status) {
    case "too-young":
      return c("red", "✖ too young");
    case "no-publish-time":
      return c("yellow", "? no date");
    case "error":
      return c("yellow", "! error");
    case "no-match":
      return c("yellow", "! no match");
    case "excluded":
      return c("gray", "– excluded");
    case "skipped":
      return c("gray", "– skipped");
    default:
      return c("green", "✔ ok");
  }
}

export function formatReport(report: Report, opts: { color: boolean; verbose: boolean; all: boolean }): string {
  const c = paint(opts.color);
  const out: string[] = [];
  const rel = (f?: string) => (f ? path.relative(report.directory, f) || path.basename(f) : "");
  for (const [label, eco] of [
    ["npm", report.npm],
    ["Python", report.python],
  ] as const) {
    if (!eco) continue;
    out.push(`${c("bold", `${label} cooldown: ${eco.policy.threshold}`)} ${c("gray", `— ${eco.policy.source}`)}`);
    out.push(c("gray", `  registry ${eco.registry} · ${eco.lockfile ? `lockfile ${rel(eco.lockfile)}` : "no lockfile (versions resolved from specifiers)"}`));
    for (const n of eco.policy.notes) out.push(c("gray", `  note: ${n}`));
  }
  const flagged = (r: Row) => r.status !== "ok" && r.status !== "skipped" && r.status !== "excluded";
  // Direct deps: show everything. Transitive (--all): only problems unless --verbose.
  const shown = report.results
    .filter((r) => opts.verbose || flagged(r) || (r.direct && r.status !== "skipped"))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  if (shown.length) {
    const multiEco = !!report.npm && !!report.python;
    const rows: string[][] = [["STATUS", "PACKAGE", "VERSION", "AGE", "PUBLISHED", "SAFE VERSION", "DETAILS"]];
    for (const r of shown) {
      const details: string[] = [];
      if (multiEco) details.push(r.ecosystem === "pypi" ? "pypi" : "npm");
      if (!r.direct) details.push("transitive");
      else if (r.spec) details.push(`spec ${r.spec}`);
      if (r.versionSource === "resolved") details.push("resolved");
      if (r.status === "too-young" && r.remainingMs !== undefined) details.push(`${formatAge(r.remainingMs)} left`);
      if (r.message) details.push(r.message);
      if (report.python && r.manifest && r.ecosystem === "pypi") details.push(rel(r.manifest));
      rows.push([
        statusLabel(r, opts.color),
        r.name,
        r.version ?? "—",
        r.ageMs !== undefined ? formatAge(r.ageMs) : "—",
        r.publishedAt ? r.publishedAt.slice(0, 10) : "—",
        r.safeVersion ? `${r.safeVersion}${r.safeVersionInRange === false ? " (outside range)" : ""}` : "",
        details.join(" · "),
      ]);
    }
    out.push("", renderTable(rows, opts.color));
  }
  const s = report.summary;
  const hidden = report.results.filter((r) => !shown.includes(r) && !r.direct && r.status !== "skipped").length;
  out.push("");
  for (const w of report.warnings) out.push(c("yellow", `warning: ${w}`));
  const parts = [`${s.checked} checked`];
  if (s.tooYoung) parts.push(c("red", `${s.tooYoung} too young`));
  if (s.noPublishTime) parts.push(c("yellow", `${s.noPublishTime} without publish time`));
  if (s.errors) parts.push(c("yellow", `${s.errors} lookup error(s)`));
  if (s.excluded) parts.push(`${s.excluded} excluded`);
  if (s.skipped) parts.push(`${s.skipped} skipped (not from a registry)`);
  if (hidden > 0) parts.push(c("gray", `${hidden} passing transitive rows hidden (--verbose shows them)`));
  out.push(parts.join(" · "));
  if (s.tooYoung || s.noPublishTime) {
    out.push(c("red", "✖ Some dependency versions are younger than the cooldown. Pin the safe versions above or wait until they age."));
  } else if (s.errors) {
    out.push(c("yellow", "! Some packages could not be checked."));
  } else {
    out.push(c("green", "✔ Every checked dependency is older than the cooldown."));
  }
  return out.join("\n");
}

export function jsonReport(report: Report, exitCode: number, toolVersion: string): string {
  return JSON.stringify({ tool: "cooldown-check", version: toolVersion, exitCode, ...report }, null, 2);
}
