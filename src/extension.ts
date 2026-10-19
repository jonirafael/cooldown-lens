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
import { RegistryClient, RegistryError } from "./registryClient";

const SOURCE = "Cooldown Lens";
const DIAG_CODE = "cooldown";

interface EntryResult {
  entry: DependencyEntry;
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
    if (!cfg().get<boolean>("enabled", true) || !isPackageJson(doc)) return;
    log(`analysing ${doc.uri.fsPath}`);
    const key = doc.uri.toString();
    const run = (runs.get(key) ?? 0) + 1;
    runs.set(key, run);
    const stale = () => runs.get(key) !== run;

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

    docResult.results = entries.map((entry) => ({ entry, spec: parseSpec(entry.name, entry.spec) }));
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

  function schedule(doc: vscode.TextDocument, delay = 600): void {
    if (!isPackageJson(doc)) return;
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
    const lead =
      a.targetKind === "installed"
        ? `Installed ${name}@${a.target}`
        : `"${r.entry.spec}" resolves to ${name}@${a.target}, which`;
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
    if (!editor || !res || !cfg().get<boolean>("enabled", true)) {
      status.hide();
      return;
    }
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

  const selector: vscode.DocumentSelector = [{ scheme: "file", pattern: "**/package.json" }];

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
        md.appendMarkdown(`Registry: ${r.registry}${r.fromCache ? " (cached)" : ""} · [npm](https://www.npmjs.com/package/${r.spec.registryName}?activeTab=versions)`);
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
      if (doc && isPackageJson(doc)) void analyse(doc, true);
      else for (const d of vscode.workspace.textDocuments) if (isPackageJson(d)) void analyse(d, true);
    }),
    vscode.commands.registerCommand("cooldownLens.clearCache", async () => {
      await client.clear();
      vscode.window.showInformationMessage("Cooldown Lens: registry cache cleared.");
      for (const d of vscode.workspace.textDocuments) if (isPackageJson(d)) void analyse(d, true);
    }),
    vscode.commands.registerCommand("cooldownLens.toggle", () => {
      inlineEnabled = !inlineEnabled;
      for (const d of vscode.workspace.textDocuments) render(d);
    }),
    vscode.commands.registerCommand("cooldownLens.showPolicy", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const res = doc && results.get(doc.uri.toString());
      if (!res) {
        vscode.window.showInformationMessage("Cooldown Lens: open a package.json to see its cooldown policy.");
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

  // ------------------------------------------------------------------ events

  const watcher = vscode.workspace.createFileSystemWatcher(`**/{${WATCHED_FILES.join(",")}}`);
  const reanalyseAll = () => {
    for (const d of vscode.workspace.textDocuments) if (isPackageJson(d)) schedule(d, 300);
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
