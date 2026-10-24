import * as path from "path";
import * as vscode from "vscode";
import { analyze, Analysis } from "./core/versions";
import { formatAge, formatThreshold } from "./core/duration";
import { findExclusion, ExcludeRule } from "./core/glob";
import { CooldownPolicy, resolvePolicy } from "./core/policy";
import { checkRegistryUrl, DEFAULT_REGISTRY, registryFor, RegistryChoice } from "./core/registryUrl";
import { parseSpec, ParsedSpec, pinSpec, rewriteSpec } from "./core/spec";
import { discoverProject, findInstalledVersion, WATCHED_FILES } from "./discovery";
import { DependencyEntry, extractDependencies, SectionInfo } from "./documentModel";
import { Ecosystem, RegistryClient, RegistryError } from "./registryClient";
import { analyzePython, isPythonManifestPath, parsePyproject, parseRequirementsTxt, PythonDependency, pythonPinSpec } from "./core/python";
import { resolvePythonPolicy } from "./core/policy";
import { discoverPythonProject, PYTHON_WATCHED_FILES } from "./discovery";

const SOURCE = "Cooldown Lens";

interface WorkspaceSummary {
  files: number;
  checked: number;
  errors: number;
  tooYoung: {
    uri: vscode.Uri;
    file: string;
    ecosystem: Ecosystem;
    name: string;
    version: string;
    ageMs?: number;
    thresholdMs: number;
    suggestion?: string;
    offset: number;
  }[];
}
const DIAG_CODE = "cooldown";

interface EntryResult {
  ecosystem: Ecosystem;
  entry: DependencyEntry;
  /** Python requirement details (ecosystem "pypi" only). */
  py?: PythonDependency;
  spec: ParsedSpec;
  registry?: string;
  analysis?: Analysis;
  excludedBy?: ExcludeRule;
  error?: string;
  fromCache?: boolean;
}

interface DocResult {
  version: number;
  policy: CooldownPolicy;
  registry: RegistryChoice;
  registryNotes: string[];
  results: EntryResult[];
  sections: SectionInfo[];
  done: boolean;
}

let output: vscode.OutputChannel;
const log = (m: string) => {
  output?.appendLine(`[${new Date().toISOString()}] ${m}`);
  if (process.env.COOLDOWN_LENS_DEBUG) console.log(`[cooldown-lens] ${m}`);
};

function cfg() {
  return vscode.workspace.getConfiguration("cooldownLens");
}

function isPackageJson(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && path.basename(doc.uri.fsPath) === "package.json" && !doc.uri.fsPath.includes(`${path.sep}node_modules${path.sep}`);
}

function isPythonManifest(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && isPythonManifestPath(doc.uri.fsPath);
}

function isManifest(doc: vscode.TextDocument): boolean {
  if (isPackageJson(doc)) return true;
  return isPythonManifest(doc) && cfg().get<boolean>("python.enabled", true);
}

/** "name@1.2.3" for npm, "name==1.2.3" for Python. */
function pkgAt(r: EntryResult, version?: string): string {
  return r.ecosystem === "pypi" ? `${r.entry.name}==${version}` : `${r.spec.registryName}@${version}`;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Cooldown Lens");
  log(`activated (VS Code ${vscode.version})`);
  const client = new RegistryClient({
    storageDir: context.globalStorageUri.fsPath,
    ttlMs: () => Math.max(0, cfg().get<number>("cacheTtlMinutes", 60)) * 60_000,
    offline: () => cfg().get<boolean>("offline", false),
    timeoutMs: () => Math.max(1, cfg().get<number>("requestTimeoutSeconds", 20)) * 1000,
    concurrency: () => Math.min(32, Math.max(1, cfg().get<number>("maxConcurrentRequests", 6))),
    log,
  });

  const diagnostics = vscode.languages.createDiagnosticCollection("cooldown-lens");
  const results = new Map<string, DocResult>();
  let workspaceSummary: WorkspaceSummary | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  const runs = new Map<string, number>();
  let inlineEnabled = cfg().get<boolean>("inlineAges", true);

  const okDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 1.5em", color: new vscode.ThemeColor("editorCodeLens.foreground") },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const warnDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 1.5em", color: new vscode.ThemeColor("editorWarning.foreground") },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const status = vscode.window.createStatusBarItem("cooldownLens.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "Cooldown Lens";
  status.command = "cooldownLens.showPolicy";
  const codeLensEmitter = new vscode.EventEmitter<void>();

  context.subscriptions.push(output, diagnostics, okDecoration, warnDecoration, status, codeLensEmitter);

  // ------------------------------------------------------------------ analysis

  async function analyse(doc: vscode.TextDocument, force = false): Promise<void> {
    if (!cfg().get<boolean>("enabled", true) || !isManifest(doc)) return;
    log(`analysing ${doc.uri.fsPath}`);
    const key = doc.uri.toString();
    const run = (runs.get(key) ?? 0) + 1;
    runs.set(key, run);
    const stale = () => runs.get(key) !== run;
    if (!isPackageJson(doc)) return analysePython(doc, force, key, stale);

    const pkgDir = path.dirname(doc.uri.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const project = await discoverProject(pkgDir, folder?.uri.fsPath, process.env);
    const policy = resolvePolicy({
      discovered: project.discovered,
      detectedManager: project.detectedManager,
      detectedBy: project.detectedBy,
      thresholdSource: cfg().get<"auto" | "setting">("thresholdSource", "auto"),
      defaultDays: cfg().get<number>("defaultCooldownDays", 7),
      extraExcludes: cfg().get<string[]>("excludePackages", []),
    });

    // Registry selection: explicit setting > project files (trusted workspaces only) > npmjs.
    const allowInsecure = cfg().get<string[]>("allowInsecureHosts", ["localhost", "127.0.0.1"]);
    const registryNotes: string[] = [];
    const pick = (raw: string | undefined, label: string): string | undefined => {
      if (!raw) return undefined;
      const c = checkRegistryUrl(raw, allowInsecure);
      if (c.ok) return c.url.toString();
      registryNotes.push(`Ignored ${label} registry: ${c.reason}`);
      return undefined;
    };
    const userRegistry = pick(cfg().get<string>("registry", ""), "configured");
    const trusted = vscode.workspace.isTrusted;
    if (!trusted && (project.registry || Object.keys(project.scopedRegistries).length)) {
      registryNotes.push("Workspace is not trusted: registry URLs from project files are ignored.");
    }
    const projectRegistry = !userRegistry && trusted ? pick(project.registry, "project") : undefined;
    const scoped: Record<string, string> = {};
    if (trusted) {
      for (const [s, u] of Object.entries(project.scopedRegistries)) {
        const v = pick(u, `${s} scoped`);
        if (v) scoped[s] = v;
      }
    }
    const registry: RegistryChoice = { base: userRegistry ?? projectRegistry ?? DEFAULT_REGISTRY, scoped };

    const { entries, sections } = extractDependencies(doc.getText(), cfg().get<string[]>("dependencyTypes", []));
    const docResult: DocResult = { version: doc.version, policy, registry, registryNotes, results: [], sections, done: false };
    const now = Date.now();

    docResult.results = entries.map((entry) => ({ ecosystem: "npm" as const, entry, spec: parseSpec(entry.name, entry.spec) }));
    results.set(key, docResult);
    render(doc);

    let lastRender = Date.now();
    await Promise.all(
      docResult.results.map(async (r) => {
        if (r.spec.kind === "unsupported") return;
        const reg = registryFor(r.spec.registryName, registry);
        r.registry = reg;
        try {
          const [{ data, fromCache }, installed] = await Promise.all([
            client.get(reg, r.spec.registryName, force),
            findInstalledVersion(pkgDir, r.entry.name, folder?.uri.fsPath),
          ]);
          if (stale()) return;
          r.fromCache = fromCache;
          r.analysis = analyze(r.spec, data, policy.thresholdMs, now, installed);
          r.excludedBy = findExclusion(policy.excludes, r.spec.registryName, r.analysis.target);
        } catch (e) {
          r.error = e instanceof RegistryError ? e.message : `unexpected error: ${(e as Error).message}`;
          if (!(e instanceof RegistryError && e.kind === "offline")) log(r.error);
        }
        if (!stale() && Date.now() - lastRender > 400) {
          lastRender = Date.now();
          render(doc);
        }
      }),
    );
    if (stale()) return;
    docResult.done = true;
    log(`done ${doc.uri.fsPath}: ${docResult.results.filter(isWarning).length} warning(s), policy ${policy.origin}`);
    render(doc);
  }

  async function analysePython(doc: vscode.TextDocument, force: boolean, key: string, stale: () => boolean): Promise<void> {
    const dir = path.dirname(doc.uri.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const project = await discoverPythonProject(dir, folder?.uri.fsPath);
    const policy = resolvePythonPolicy({
      project: project.setting,
      projectExcludes: project.excludes,
      projectWarnings: project.warnings,
      thresholdSource: cfg().get<"auto" | "setting">("thresholdSource", "auto"),
      pythonDays: cfg().get<number | null>("python.minimumReleaseAgeDays", null),
      defaultDays: cfg().get<number>("defaultCooldownDays", 7),
      extraExcludes: cfg().get<string[]>("excludePackages", []),
    });
    const allowInsecure = cfg().get<string[]>("allowInsecureHosts", ["localhost", "127.0.0.1"]);
    const registryNotes: string[] = [];
    let base = "https://pypi.org/";
    const configured = cfg().get<string>("python.index", "");
    if (configured) {
      const c = checkRegistryUrl(configured, allowInsecure);
      if (c.ok) base = c.url.toString();
      else registryNotes.push(`Ignored configured Python index: ${c.reason}`);
    }
    const registry: RegistryChoice = { base, scoped: {} };
    const text = doc.getText();
    const parsed = path.basename(doc.uri.fsPath) === "pyproject.toml" ? parsePyproject(text) : parseRequirementsTxt(text);
    if ("warnings" in parsed) policy.notes.push(...parsed.warnings);
    const sections: SectionInfo[] = [];
    const entries: EntryResult[] = parsed.deps.map((d) => {
      const entry: DependencyEntry = {
        section: d.section,
        name: d.name,
        spec: d.spec,
        keyOffset: d.nameOffset,
        keyLength: d.nameLength,
        valueOffset: d.specLength ? d.specOffset : d.nameOffset,
        valueLength: d.specLength ? d.specLength : d.nameLength,
        lineEndOffset: d.lineEndOffset,
      };
      if (!sections.some((s) => s.section === d.section)) {
        sections.push({ section: d.section, keyOffset: doc.offsetAt(doc.positionAt(d.nameOffset).with({ character: 0 })) });
      }
      const spec: ParsedSpec = d.unsupported
        ? { kind: "unsupported", registryName: d.normalized, value: d.spec, reason: d.unsupported }
        : { kind: "range", registryName: d.normalized, value: d.spec };
      return { ecosystem: "pypi" as const, entry, py: d, spec };
    });
    const docResult: DocResult = { version: doc.version, policy, registry, registryNotes, results: entries, sections, done: false };
    results.set(key, docResult);
    render(doc);
    const now = Date.now();
    let lastRender = Date.now();
    await Promise.all(
      entries.map(async (r) => {
        if (r.spec.kind === "unsupported" || !r.py?.specifiers) return;
        r.registry = base;
        try {
          const { data, fromCache } = await client.get(base, r.py.name, force, "pypi");
          if (stale()) return;
          r.fromCache = fromCache;
          r.analysis = analyzePython(r.py.specifiers, data, policy.thresholdMs, now);
          r.excludedBy = findExclusion(policy.excludes, r.py.normalized, r.analysis.target);
        } catch (e) {
          r.error = e instanceof RegistryError ? e.message : `unexpected error: ${(e as Error).message}`;
          if (!(e instanceof RegistryError && e.kind === "offline")) log(r.error);
        }
        if (!stale() && Date.now() - lastRender > 400) {
          lastRender = Date.now();
          render(doc);
        }
      }),
    );
    if (stale()) return;
    docResult.done = true;
    log(`done ${doc.uri.fsPath}: ${entries.filter(isWarning).length} warning(s), policy ${policy.origin}`);
    render(doc);
  }

  function schedule(doc: vscode.TextDocument, delay = 600): void {
    if (!isManifest(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        analyse(doc).catch((e) => log(`analysis failed: ${(e as Error).stack ?? e}`));
      }, delay),
    );
  }

  // ------------------------------------------------------------------ rendering

  function severity(): vscode.DiagnosticSeverity {
    switch (cfg().get<string>("diagnosticSeverity", "warning")) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "information":
        return vscode.DiagnosticSeverity.Information;
      case "hint":
        return vscode.DiagnosticSeverity.Hint;
      default:
        return vscode.DiagnosticSeverity.Warning;
    }
  }

  function inlineText(r: EntryResult, policy: CooldownPolicy): { text: string; warn: boolean } | undefined {
    if (r.spec.kind === "unsupported") return undefined;
    if (r.error) return { text: `⏱ ${r.error.includes("offline") ? "offline – not cached" : "registry unavailable"}`, warn: false };
    const a = r.analysis;
    if (!a) return { text: "⏱ …", warn: false };
    if (!a.target) return { text: "⏱ no matching version", warn: true };
    const what = a.targetKind === "installed" ? `${a.target} installed` : a.target;
    if (a.missingTime) return { text: `⏱ ${what} · no publish time`, warn: !r.excludedBy };
    const age = formatAge(a.targetAgeMs ?? 0);
    if (r.excludedBy) return { text: `⏱ ${what} · ${age} old · excluded`, warn: false };
    if (a.inCooldown) {
      const sug = a.suggestion ? ` · safe: ${a.suggestion}` : "";
      return { text: `⚠ ${what} · ${age} old · cooldown ${formatThreshold(policy.thresholdMs)}${sug}`, warn: true };
    }
    return { text: `⏱ ${what} · ${age} old`, warn: false };
  }

  function isWarning(r: EntryResult): boolean {
    const a = r.analysis;
    return !!a && !r.excludedBy && !!a.target && (a.inCooldown || a.missingTime);
  }

  function diagnosticMessage(r: EntryResult, policy: CooldownPolicy): string {
    const a = r.analysis!;
    const name = r.spec.registryName;
    const thr = formatThreshold(policy.thresholdMs);
    void name;
    const lead =
      a.targetKind === "installed"
        ? `Installed ${pkgAt(r, a.target)}`
        : `${r.entry.spec ? `"${r.entry.spec}"` : `Unconstrained ${name}`} resolves to ${pkgAt(r, a.target)}, which`;
    const body = a.missingTime
      ? `${lead} has no publish time in the registry metadata, so its age cannot be verified (cooldown: ${thr}).`
      : `${lead} was published ${formatAge(a.targetAgeMs!)} ago and is still inside the cooldown of ${thr} (${formatAge(a.remainingMs!)} left; ${policy.origin}).`;
    let sug: string;
    if (!a.suggestion) sug = " No older version passes the cooldown.";
    else if (a.suggestionInRange)
      sug =
        a.targetKind === "resolved" && policy.kind === "project"
          ? ` A cooldown-enforcing install would pick ${a.suggestion}; pin it to be explicit.`
          : ` Newest version in range that passes the cooldown: ${a.suggestion}.`;
    else sug = ` No version in "${r.entry.spec}" passes the cooldown; newest older version that does: ${a.suggestion}.`;
    return body + sug;
  }

  function render(doc: vscode.TextDocument): void {
    const res = results.get(doc.uri.toString());
    if (!res) return;
    const diags: vscode.Diagnostic[] = [];
    for (const r of res.results) {
      if (!isWarning(r)) continue;
      const range = new vscode.Range(doc.positionAt(r.entry.valueOffset), doc.positionAt(r.entry.valueOffset + r.entry.valueLength));
      const d = new vscode.Diagnostic(range, diagnosticMessage(r, res.policy), severity());
      d.source = SOURCE;
      d.code = { value: DIAG_CODE, target: vscode.Uri.parse("https://cooldowns.dev/") };
      diags.push(d);
    }
    diagnostics.set(doc.uri, diags);

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== doc.uri.toString()) continue;
      const ok: vscode.DecorationOptions[] = [];
      const warn: vscode.DecorationOptions[] = [];
      if (inlineEnabled) {
        for (const r of res.results) {
          const t = inlineText(r, res.policy);
          if (!t) continue;
          const pos = doc.positionAt(r.entry.lineEndOffset);
          const line = doc.lineAt(pos.line);
          const opt: vscode.DecorationOptions = {
            range: new vscode.Range(line.range.end, line.range.end),
            renderOptions: { after: { contentText: t.text } },
          };
          (t.warn ? warn : ok).push(opt);
        }
      }
      editor.setDecorations(okDecoration, ok);
      editor.setDecorations(warnDecoration, warn);
    }
    codeLensEmitter.fire();
    updateStatus();
  }

  function updateStatus(): void {
    const editor = vscode.window.activeTextEditor;
    const res = editor && results.get(editor.document.uri.toString());
    if (!cfg().get<boolean>("enabled", true)) {
      status.hide();
      return;
    }
    const ws = workspaceSummary;
    const wsLine = ws
      ? `Workspace (last "Check All Dependencies"): ${ws.tooYoung.length} too young in ${ws.files} manifest(s), ${ws.checked} checked`
      : undefined;
    if (!editor || !res) {
      if (!ws) {
        status.hide();
        return;
      }
      status.text = `$(shield) workspace${ws.tooYoung.length ? ` $(warning) ${ws.tooYoung.length}` : " $(check)"}`;
      status.tooltip = new vscode.MarkdownString(`**Cooldown Lens**\n\n${wsLine}\n\nClick to re-run the workspace check.`);
      status.command = "cooldownLens.checkAll";
      status.backgroundColor = ws.tooYoung.length ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      status.show();
      return;
    }
    status.command = "cooldownLens.showPolicy";
    const warnings = res.results.filter(isWarning).length;
    const checked = res.results.filter((r) => r.analysis).length;
    const total = res.results.filter((r) => r.spec.kind !== "unsupported").length;
    const thr = formatThreshold(res.policy.thresholdMs).replace(/ days?/, "d").replace(/ hours?/, "h").replace(/ minutes?/, "m");
    const offline = cfg().get<boolean>("offline", false) ? " $(cloud-offline)" : "";
    const progress = res.done ? "" : ` $(sync~spin) ${checked}/${total}`;
    status.text = `$(shield) ${thr}${warnings ? ` $(warning) ${warnings}` : " $(check)"}${progress}${offline}`;
    status.tooltip = new vscode.MarkdownString(
      [
        `**Cooldown Lens** — ${formatThreshold(res.policy.thresholdMs)}`,
        `Source: ${res.policy.origin}`,
        `Registry: ${res.registry.base}`,
        `${checked}/${total} dependencies checked, ${warnings} inside cooldown`,
        ...(wsLine ? [wsLine] : []),
        ...res.policy.notes.map((n) => `- ${n}`),
        ...res.registryNotes.map((n) => `- ${n}`),
      ].join("\n\n"),
    );
    status.backgroundColor = warnings ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
  }

  function entryAt(doc: vscode.TextDocument, pos: vscode.Position): { res: DocResult; r: EntryResult } | undefined {
    const res = results.get(doc.uri.toString());
    if (!res) return undefined;
    const off = doc.offsetAt(pos);
    const r = res.results.find(
      (x) => (off >= x.entry.keyOffset && off <= x.entry.keyOffset + x.entry.keyLength) || (off >= x.entry.valueOffset && off <= x.entry.valueOffset + x.entry.valueLength),
    );
    return r ? { res, r } : undefined;
  }

  // ------------------------------------------------------------------ providers

  const selector: vscode.DocumentSelector = [
    { scheme: "file", pattern: "**/package.json" },
    { scheme: "file", pattern: "**/pyproject.toml" },
    { scheme: "file", pattern: "**/*requirements*.{txt,in}" },
    { scheme: "file", pattern: "**/*constraints*.{txt,in}" },
    { scheme: "file", pattern: "**/requirements/*.{txt,in}" },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, pos) {
        const hit = entryAt(doc, pos);
        if (!hit) return undefined;
        const { res, r } = hit;
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = false;
        md.appendMarkdown(`**$(shield) Cooldown Lens — \`${r.spec.registryName}\`**\n\n`);
        if (r.spec.kind === "unsupported") {
          md.appendMarkdown(`Not checked: ${r.spec.reason}.`);
          return new vscode.Hover(md);
        }
        if (r.error) {
          md.appendMarkdown(`⚠️ ${r.error}`);
          return new vscode.Hover(md);
        }
        const a = r.analysis;
        if (!a) {
          md.appendMarkdown("Fetching registry metadata…");
          return new vscode.Hover(md);
        }
        const rows: string[] = ["| | version | published | age |", "|---|---|---|---|"];
        const row = (label: string, v?: string, ageMs?: number, date?: Date) => {
          if (v) rows.push(`| ${label} | \`${v}\` | ${date ? date.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—"} | ${ageMs !== undefined ? formatAge(ageMs) : "—"} |`);
        };
        const now = Date.now();
        row(a.targetKind === "installed" ? "installed" : "resolves to", a.target, a.targetAgeMs, a.targetPublished);
        if (a.installed && a.resolved && a.resolved !== a.installed) row("range now resolves to", a.resolved);
        if (a.latest && a.latest !== a.target) row("latest", a.latest, a.latestAgeMs, a.latestAgeMs !== undefined ? new Date(now - a.latestAgeMs) : undefined);
        if (a.safeInRange && a.safeInRange !== a.target)
          row("newest safe in range", a.safeInRange, a.safeInRangeAgeMs, a.safeInRangeAgeMs !== undefined ? new Date(now - a.safeInRangeAgeMs) : undefined);
        if (a.suggestion && !a.suggestionInRange)
          row("newest safe (outside range)", a.suggestion, a.suggestionAgeMs, a.suggestionAgeMs !== undefined ? new Date(now - a.suggestionAgeMs) : undefined);
        md.appendMarkdown(rows.join("\n") + "\n\n");
        if (r.excludedBy) md.appendMarkdown(`Exempt from the cooldown by \`${r.excludedBy.name}\` (${r.excludedBy.source}).\n\n`);
        else if (a.inCooldown) md.appendMarkdown(`⚠️ **Inside the cooldown** — ${formatAge(a.remainingMs ?? 0)} left.\n\n`);
        else if (a.missingTime) md.appendMarkdown("⚠️ The registry did not return a publish time for this version.\n\n");
        else md.appendMarkdown("✅ Older than the cooldown.\n\n");
        if (a.freshInRange) md.appendMarkdown(`${a.freshInRange} version(s) matching \`${r.entry.spec}\` are still inside the cooldown.\n\n`);
        md.appendMarkdown(`Cooldown: **${formatThreshold(res.policy.thresholdMs)}** — ${res.policy.origin}\n\n`);
        if (a.suggestion && (a.inCooldown || a.missingTime)) md.appendMarkdown("Quick fix available (Ctrl+. / Cmd+.).\n\n");
        const link =
          r.ecosystem === "pypi"
            ? `[PyPI](https://pypi.org/project/${encodeURIComponent(r.spec.registryName)}/#history)`
            : `[npm](https://www.npmjs.com/package/${r.spec.registryName}?activeTab=versions)`;
        md.appendMarkdown(`${r.ecosystem === "pypi" ? "Index" : "Registry"}: ${r.registry}${r.fromCache ? " (cached)" : ""} · ${link}`);
        return new vscode.Hover(md);
      },
    }),

    vscode.languages.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(doc, _range, ctx) {
          const actions: vscode.CodeAction[] = [];
          for (const d of ctx.diagnostics) {
            if (d.source !== SOURCE) continue;
            const hit = entryAt(doc, d.range.start);
            const a = hit?.r.analysis;
            if (!hit || !a?.suggestion) continue;
            const { entry, spec } = hit.r;
            if (hit.r.ecosystem === "pypi" && hit.r.py) {
              const py = hit.r.py;
              const pinned = pythonPinSpec(py, a.suggestion);
              const fix = new vscode.CodeAction(
                `Pin ${entry.name} to ${pinned} (newest version${a.suggestionInRange ? " in range" : ""} past the cooldown)`,
                vscode.CodeActionKind.QuickFix,
              );
              fix.diagnostics = [d];
              fix.isPreferred = true;
              fix.edit = new vscode.WorkspaceEdit();
              if (py.specLength) fix.edit.replace(doc.uri, d.range, pinned);
              else fix.edit.insert(doc.uri, doc.positionAt(py.nameOffset + py.nameLength), pinned);
              actions.push(fix);
              continue;
            }
            // In range: a pin is the only edit that changes what a cooldown-unaware install picks.
            // Outside range: move the range to the safe version, keeping the operator.
            const newSpec = a.suggestionInRange
              ? pinSpec(entry.spec, a.suggestion, spec.registryName, entry.name)
              : rewriteSpec(entry.spec, a.suggestion, spec.registryName, entry.name);
            const title = a.suggestionInRange
              ? `Pin ${spec.registryName} to ${newSpec} (newest version in range past the cooldown)`
              : `Change ${spec.registryName} to ${newSpec} (newest version past the cooldown; outside the current range)`;
            const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            fix.diagnostics = [d];
            fix.isPreferred = true;
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(doc.uri, d.range, newSpec);
            actions.push(fix);
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),

    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: codeLensEmitter.event,
      provideCodeLenses(doc) {
        if (!cfg().get<boolean>("codeLens", true)) return [];
        const res = results.get(doc.uri.toString());
        if (!res) return [];
        return res.sections.map((s) => {
          const inSection = res.results.filter((r) => r.entry.section === s.section);
          const warn = inSection.filter(isWarning).length;
          const checked = inSection.filter((r) => r.analysis).length;
          const pos = doc.positionAt(s.keyOffset);
          const title = `$(shield) cooldown ${formatThreshold(res.policy.thresholdMs)} · ${warn ? `${warn} inside cooldown` : "all clear"} · ${checked}/${inSection.length} checked`;
          return new vscode.CodeLens(new vscode.Range(pos, pos), { title, command: "cooldownLens.showPolicy", tooltip: res.policy.origin });
        });
      },
    }),
  );

  // ------------------------------------------------------------------ commands

  context.subscriptions.push(
    vscode.commands.registerCommand("cooldownLens.refresh", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && isManifest(doc)) void analyse(doc, true);
      else for (const d of vscode.workspace.textDocuments) if (isManifest(d)) void analyse(d, true);
    }),
    vscode.commands.registerCommand("cooldownLens.clearCache", async () => {
      await client.clear();
      vscode.window.showInformationMessage("Cooldown Lens: registry cache cleared.");
      for (const d of vscode.workspace.textDocuments) if (isManifest(d)) void analyse(d, true);
    }),
    vscode.commands.registerCommand("cooldownLens.checkAll", () => checkAll()),
    vscode.commands.registerCommand("cooldownLens.toggle", () => {
      inlineEnabled = !inlineEnabled;
      for (const d of vscode.workspace.textDocuments) render(d);
    }),
    vscode.commands.registerCommand("cooldownLens.showPolicy", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const res = doc && results.get(doc.uri.toString());
      if (!res) {
        vscode.window.showInformationMessage("Cooldown Lens: open a package.json, requirements.txt or pyproject.toml to see its cooldown policy.");
        return;
      }
      const lines = [
        `Cooldown: ${formatThreshold(res.policy.thresholdMs)}`,
        `Source: ${res.policy.origin}`,
        `Registry: ${res.registry.base}`,
        `Excludes: ${res.policy.excludes.map((e) => e.name + (e.versions.length ? `@${e.versions.join("||")}` : "")).join(", ") || "none"}`,
        ...res.policy.notes,
        ...res.registryNotes,
        `Requests: ${client.requests}, cache hits: ${client.cacheHits}`,
      ];
      lines.forEach((l) => output.appendLine(l));
      output.show(true);
      if (res.policy.file) {
        const pick = await vscode.window.showInformationMessage(`Cooldown ${formatThreshold(res.policy.thresholdMs)} from ${res.policy.origin}`, "Open config file");
        if (pick) await vscode.window.showTextDocument(vscode.Uri.file(res.policy.file));
      }
    }),
  );

  // ------------------------------------------------------------------ workspace check

  async function checkAll(): Promise<WorkspaceSummary> {
    const exclude = "**/{node_modules,.venv,venv,.tox,.nox,site-packages,.git,bower_components}/**";
    const max = Math.max(1, cfg().get<number>("checkAll.maxFiles", 200));
    const patterns = ["**/package.json", "**/pyproject.toml", "**/*requirements*.{txt,in}", "**/*constraints*.{txt,in}", "**/requirements/*.{txt,in}"];
    const summary: WorkspaceSummary = { files: 0, checked: 0, tooYoung: [], errors: 0 };
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Cooldown Lens: checking dependencies", cancellable: true },
      async (progress, token) => {
        const seen = new Map<string, vscode.Uri>();
        for (const p of patterns) for (const u of await vscode.workspace.findFiles(p, exclude, max)) seen.set(u.toString(), u);
        const uris = [...seen.values()]
          .filter((u) => path.basename(u.fsPath) === "package.json" || isPythonManifestPath(u.fsPath))
          .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
          .slice(0, max);
        let i = 0;
        for (const uri of uris) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${++i}/${uris.length} ${vscode.workspace.asRelativePath(uri)}`, increment: 100 / uris.length });
          let doc: vscode.TextDocument;
          try {
            doc = await vscode.workspace.openTextDocument(uri);
          } catch {
            continue;
          }
          if (!isManifest(doc)) continue;
          const key = doc.uri.toString();
          clearTimeout(timers.get(key));
          timers.delete(key);
          await analyse(doc);
          // A concurrent edit/open may have restarted the analysis; wait for whichever run is current.
          for (let waited = 0; !results.get(key)?.done && waited < 60_000 && !token.isCancellationRequested; waited += 100) {
            await new Promise((r) => setTimeout(r, 100));
          }
          const res = results.get(key);
          if (!res) continue;
          summary.files++;
          for (const r of res.results) {
            if (r.analysis) summary.checked++;
            if (r.error) summary.errors++;
            if (isWarning(r))
              summary.tooYoung.push({
                uri: doc.uri,
                file: vscode.workspace.asRelativePath(doc.uri),
                ecosystem: r.ecosystem,
                name: r.spec.registryName,
                version: r.analysis!.target!,
                ageMs: r.analysis!.targetAgeMs,
                thresholdMs: res.policy.thresholdMs,
                suggestion: r.analysis!.suggestion,
                offset: r.entry.valueOffset,
              });
          }
        }
      },
    );
    workspaceSummary = summary;
    updateStatus();
    output.appendLine(`Check All Dependencies: ${summary.tooYoung.length} too young, ${summary.checked} checked in ${summary.files} manifest(s)${summary.errors ? `, ${summary.errors} registry error(s)` : ""}`);
    for (const t of summary.tooYoung)
      output.appendLine(`  ${t.file}: ${t.name} ${t.version} — ${t.ageMs !== undefined ? formatAge(t.ageMs) + " old" : "no publish time"}, cooldown ${formatThreshold(t.thresholdMs)}${t.suggestion ? `, safe: ${t.suggestion}` : ""}`);
    if (!summary.tooYoung.length) {
      void vscode.window.showInformationMessage(
        `Cooldown Lens: all ${summary.checked} dependencies in ${summary.files} manifest(s) are older than their cooldown.`,
      );
    } else {
      const items = summary.tooYoung.map((t) => ({
        label: `$(warning) ${t.name} ${t.version}`,
        description: `${t.ageMs !== undefined ? formatAge(t.ageMs) + " old" : "no publish time"} · cooldown ${formatThreshold(t.thresholdMs)}${t.suggestion ? ` · safe: ${t.suggestion}` : ""}`,
        detail: `${t.file} (${t.ecosystem})`,
        t,
      }));
      // Not awaited: the command resolves with the summary while the picker stays open.
      void vscode.window
        .showQuickPick(items, { title: `Cooldown Lens: ${summary.tooYoung.length} dependencies inside the cooldown`, matchOnDescription: true, matchOnDetail: true })
        .then(async (pick) => {
          if (!pick) return;
          const editor = await vscode.window.showTextDocument(pick.t.uri);
          const pos = editor.document.positionAt(pick.t.offset);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        });
    }
    return summary;
  }

  // ------------------------------------------------------------------ events

  const watcher = vscode.workspace.createFileSystemWatcher(`**/{${[...WATCHED_FILES, ...PYTHON_WATCHED_FILES].join(",")}}`);
  const reanalyseAll = () => {
    for (const d of vscode.workspace.textDocuments) if (isManifest(d)) schedule(d, 300);
  };
  watcher.onDidChange(reanalyseAll);
  watcher.onDidCreate(reanalyseAll);
  watcher.onDidDelete(reanalyseAll);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 50)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => schedule(d, 50)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      results.delete(d.uri.toString());
      diagnostics.delete(d.uri);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const e of vscode.window.visibleTextEditors) render(e.document);
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidGrantWorkspaceTrust(reanalyseAll),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("cooldownLens")) return;
      inlineEnabled = cfg().get<boolean>("inlineAges", true);
      if (!cfg().get<boolean>("enabled", true)) {
        diagnostics.clear();
        results.clear();
        for (const ed of vscode.window.visibleTextEditors) {
          ed.setDecorations(okDecoration, []);
          ed.setDecorations(warnDecoration, []);
        }
        updateStatus();
        return;
      }
      reanalyseAll();
    }),
  );

  for (const d of vscode.workspace.textDocuments) schedule(d, 50);
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}
