import * as assert from "assert";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

// Fake registry served on 127.0.0.1 (allowed over http by the default allowInsecureHosts).
const PACKUMENTS: Record<string, unknown> = {
  "fresh-lib": {
    "dist-tags": { latest: "1.3.0" },
    time: { "1.0.0": iso(300), "1.2.0": iso(30), "1.3.0": iso(1) },
    versions: { "1.0.0": {}, "1.2.0": {}, "1.3.0": {} },
  },
  "old-lib": {
    "dist-tags": { latest: "2.0.0" },
    time: { "2.0.0": iso(400) },
    versions: { "2.0.0": {} },
  },
  "@scope/pinned": {
    "dist-tags": { latest: "0.5.0" },
    time: { "0.4.0": iso(60), "0.5.0": iso(2) },
    versions: { "0.4.0": {}, "0.5.0": {} },
  },
};

async function waitFor<T>(fn: () => T | undefined, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("Cooldown Lens (VS Code integration)", () => {
  let server: http.Server;
  let requests: string[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? "/").slice(1));
      requests.push(`${name} auth=${req.headers.authorization ?? "none"}`);
      const body = PACKUMENTS[name];
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { error: "not found" }));
    });
    await new Promise<void>((r) => server.listen(48731, "127.0.0.1", r));
  });

  after(() => server.close());

  it("flags fresh versions, ignores old ones and offers a quick fix", async () => {
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const uri = vscode.Uri.file(path.join(folder, "package.json"));
    const ext = vscode.extensions.getExtension("jonirafael.cooldown-lens");
    assert.ok(ext, "extension not found");
    await ext!.activate();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(uri).filter((x) => x.source === "Cooldown Lens");
      return d.length >= 2 ? d : undefined;
    });
    await new Promise((r) => setTimeout(r, 1000));
    const all = vscode.languages.getDiagnostics(uri).filter((x) => x.source === "Cooldown Lens");
    assert.strictEqual(all.length, 2, all.map((d) => d.message).join("\n"));
    const fresh = diags.find((d) => d.message.includes("fresh-lib"))!;
    assert.ok(fresh, "fresh-lib should be flagged");
    assert.match(fresh.message, /cooldown of 3 days/);
    assert.match(fresh.message, /\.npmrc min-release-age=3/);
    assert.ok(all.some((d) => d.message.includes("@scope/pinned")), "@scope/pinned should be flagged");
    assert.ok(!all.some((d) => d.message.includes("old-lib")), "old-lib must not be flagged");

    // no credentials are ever sent
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => r.endsWith("auth=none")), requests.join(","));

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, fresh.range);
    const fix = actions.find((a) => a.title.includes("Pin fresh-lib to 1.2.0"));
    assert.ok(fix, `expected quick fix, got: ${actions.map((a) => a.title).join(" | ")}`);
    await vscode.workspace.applyEdit(fix!.edit!);
    assert.match(doc.getText(), /"fresh-lib": "1\.2\.0"/);
    // after re-analysis the pinned version is old enough -> only @scope/pinned remains
    await waitFor(() => {
      const d = vscode.languages.getDiagnostics(uri).filter((x) => x.source === "Cooldown Lens");
      return d.length === 1 && d[0].message.includes("@scope/pinned") ? d : undefined;
    });
    const pinned = vscode.languages.getDiagnostics(uri).find((x) => x.message.includes("@scope/pinned"))!;
    const pinActions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, pinned.range);
    assert.ok(pinActions.some((a) => a.title.includes("Change @scope/pinned to 0.4.0")), pinActions.map((a) => a.title).join(" | "));

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, fresh.range.start);
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))).join("\n");
    assert.match(text, /Cooldown Lens/);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
    assert.ok(lenses.some((l) => l.command?.title.includes("cooldown 3 days")));

    // revert edit so the fixture stays clean
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });
});
