# Outreach drafts (NOT posted)

Everything below is a draft. Nothing has been posted anywhere. Review, edit and post manually, ideally only after the
extension is live on the Marketplace / Open VSX so the links work for readers.

Repository: https://github.com/jonirafael/cooldown-lens

---

## 1. microsoft/vscode#267385 — "Support pnpm's minimumReleaseAge configuration when suggesting npm version ranges"

URL: https://github.com/microsoft/vscode/issues/267385 (open, backlog, assignee mjbvz)

> In the meantime, for anyone who wants this today: I built a small MIT-licensed extension,
> [Cooldown Lens](https://github.com/jonirafael/cooldown-lens), that reads the cooldown the project already configures
> and surfaces it in `package.json`: inline release age per dependency, a warning diagnostic when the
> installed/resolved version is still inside the cooldown, and a quick fix to the newest version that passes it.
>
> It reads all four JS package managers, since their keys and units differ (verified against their docs):
>
> | Tool | File / key | Unit |
> |---|---|---|
> | npm ≥ 11.10 | `.npmrc` `min-release-age` | days |
> | pnpm ≥ 10.16 | `pnpm-workspace.yaml` `minimumReleaseAge` (v10 also `.npmrc` `minimum-release-age`) | minutes |
> | Yarn ≥ 4.10 | `.yarnrc.yml` `npmMinimalAgeGate` | duration (`"3d"`); bare number = minutes |
> | Bun ≥ 1.3 | `bunfig.toml` `[install] minimumReleaseAge` | seconds |
>
> Exclude lists are honoured too (`min-release-age-exclude`, `minimumReleaseAgeExclude`, `npmPreapprovedPackages`,
> `minimumReleaseAgeExcludes`). If it helps the built-in npm extension, the parsing and version-selection logic is
> self-contained in `src/core/` with unit tests, and I'd be happy to help upstream a version of it (e.g. filtering the
> version completions and hover "latest" by the configured cooldown).

---

## 2. cooldowns.dev (source: https://github.com/mprpic/cooldowns)

Per the repo's `AGENTS.md`, content lives in `README.md` (not `docs/index.md`), and markdown should be checked with
`uv run --with mdlint mdlint check` and `uv run --with zensical zensical build`.

**PR title:** Add Cooldown Lens (VS Code extension that surfaces JS cooldowns in package.json)

**Proposed README.md addition** (new subsection directly after the "Security scanners and PR checks" list, or as a new
"Editor integrations" section before "Registry-level proxies"):

```markdown
## Editor integrations

- [Cooldown Lens](https://github.com/jonirafael/cooldown-lens) is a VS Code extension that shows the release age of
  every dependency in `package.json` and warns when the installed or resolved version is still inside the cooldown.
  It reads the threshold from the project's own configuration (`min-release-age` in `.npmrc`, `minimumReleaseAge` in
  `pnpm-workspace.yaml` or `bunfig.toml`, `npmMinimalAgeGate` in `.yarnrc.yml`) and their exclude lists, falling back
  to a configurable default, and offers a quick fix to the newest version that passes the cooldown. It does not enforce
  anything at install time; configure your package manager as described above.
```

**PR body:**

> Adds a short "Editor integrations" section listing Cooldown Lens, an MIT VS Code extension that makes the JS package
> manager cooldowns documented on this page visible while editing `package.json`. It uses the same keys/units as the
> npm, pnpm, Yarn and Bun sections. Ran `mdlint check` and `zensical build` locally. Happy to move or trim the entry if
> you prefer a different place (or none). Disclosure: I'm the author.

(Optional changelog line, only if the maintainer considers it a "larger addition":
`- 2026-10-XX: Added an editor integrations section (Cooldown Lens for VS Code).`)

---

## 3. Awesome lists

### bureado/awesome-software-supply-chain-security

URL: https://github.com/bureado/awesome-software-supply-chain-security — section **"Point-of-use validations"**
(already lists a VS Code security extension, `luisfontes19/watchtower`). Entry in the list's `owner/repo: description`
style:

```markdown
* [jonirafael/cooldown-lens: VS Code extension that shows npm dependency release ages in package.json and flags versions still inside the npm/pnpm/Yarn/Bun minimum-release-age cooldown, with a quick fix to the newest version that passes it](https://github.com/jonirafael/cooldown-lens)
```

PR title: `Add jonirafael/cooldown-lens to Point-of-use validations`
PR body: `Adds Cooldown Lens, an MIT VS Code extension that surfaces dependency cooldowns (minimum release age) at edit time. Disclosure: I'm the author.`

### viatsko/awesome-vscode (later)

https://github.com/viatsko/awesome-vscode — only worth submitting once the extension is on the Marketplace and has some
installs; check its CONTRIBUTING rules first.

---

## 4. ChainDrop threads (1–2 comments)

### 4a. jaredwray/keyv#2051 — "[URGENT] Repository and package compromised"

URL: https://github.com/jaredwray/keyv/issues/2051 (closed 2026-08-05, not locked, 7 comments; a maintainer and
others already discuss minimum install age). Keep it short and on-topic; the thread is about recovery, so consider
skipping if it feels like self-promotion.

> Thanks for the fast recovery work. Adding to @ryanolee's reminder: a cooldown would have blocked `keyv@6.0.0` for
> anyone who had one set (`min-release-age=3` in `.npmrc`, `minimumReleaseAge: 4320` in `pnpm-workspace.yaml`,
> `npmMinimalAgeGate: "3d"` in `.yarnrc.yml`, or `minimumReleaseAge = 259200` under `[install]` in `bunfig.toml`;
> see https://cooldowns.dev). If you want to *see* which entries in a `package.json` are still inside that window, I
> made a small MIT VS Code extension for it: https://github.com/jonirafael/cooldown-lens

### 4b. Hacker News — "ChainDrop NPM supply-chain attack infects packages"

URL: https://news.ycombinator.com/item?id=49171658 (BleepingComputer link, 1 comment). Note: HN stops accepting
replies on older stories; if the reply box is gone, skip this one (or use a future "Show HN" instead).

> The most effective cheap mitigation here is a cooldown: npm `min-release-age` (days), pnpm `minimumReleaseAge`
> (minutes), Yarn `npmMinimalAgeGate` (duration) and Bun `minimumReleaseAge` (seconds). Every malicious version in this
> worm was pulled within hours, so even a 1–3 day window would have skipped it. The units are all different, which is
> why I wrote a VS Code extension that reads whichever one your project uses and highlights too-fresh versions in
> package.json: https://github.com/jonirafael/cooldown-lens

### Possible "Show HN" (optional, after Marketplace release)

Title: `Show HN: Cooldown Lens – see which npm deps are still inside your min-release-age window`
