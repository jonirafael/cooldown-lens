# cooldown-check

**Fail your CI when a dependency is younger than your supply-chain cooldown.**

`cooldown-check` reads your `package.json` + lockfile and your Python `requirements.txt` / `pyproject.toml`,
looks up when each resolved version was published on the npm registry or PyPI, and flags every dependency
that is younger than your **dependency cooldown** (minimum release age). It exits non-zero so a fresh —
and possibly compromised — release never slips into a build unnoticed.

```bash
npx cooldown-check                # check the current project
npx cooldown-check --min-age 7d   # enforce a 7-day minimum dependency age
npx cooldown-check --json         # machine-readable output
```

Zero runtime dependencies, Node.js 18+.

> Prefer seeing this inline while you edit? Install the **[Cooldown Lens VS Code extension](https://marketplace.visualstudio.com/items?itemName=jonirafael.cooldown-lens)** — same engine, with hovers, diagnostics and one-click "pin safe version" quick fixes.

## Why a cooldown?

Most npm and PyPI supply chain attacks (hijacked maintainer accounts, malicious patch releases, typosquats)
are detected and yanked within hours or a few days. Waiting a few days before adopting a new version —
a *cooldown* — removes most of that risk. Package managers now support it natively:

| Tool | Setting | Unit |
| --- | --- | --- |
| npm | `min-release-age` in `.npmrc` | days |
| pnpm | `minimumReleaseAge` in `pnpm-workspace.yaml` | minutes |
| Yarn (Berry) | `npmMinimalAgeGate` in `.yarnrc.yml` | duration |
| Bun | `minimumReleaseAge` in `bunfig.toml` | seconds |
| uv | `exclude-newer` in `pyproject.toml` `[tool.uv]` or `uv.toml` | date or duration |

`cooldown-check` reads those settings (including exclusion lists such as `minimumReleaseAgeExclude`,
`npmPreapprovedPackages`, `minimumReleaseAgeExcludes` and `exclude-newer-package`), so CI enforces exactly
what your package manager is configured for — and it also works when **no** cooldown is configured
(default: 7 days, or whatever you pass with `--min-age`).

## What it checks

- **npm / pnpm / Yarn / Bun:** `dependencies`, `optionalDependencies`, `peerDependencies` and
  `devDependencies` in `package.json`, using the exact versions from `package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (v1 and Berry) or `bun.lock`. Without a lockfile, the
  highest version matching the range is checked. Registry and scoped registries come from `.npmrc`,
  `.yarnrc.yml` or `bunfig.toml`.
- **Python / PyPI:** `requirements*.txt`, `constraints*.txt`, `requirements/*.txt`, and `pyproject.toml`
  (`[project.dependencies]`, `optional-dependencies`, PEP 735 `[dependency-groups]`, Poetry). Exact versions
  come from `uv.lock`, `poetry.lock` or `pylock.toml` (PEP 751) when present; otherwise the newest version matching the
  PEP 440 specifier is checked.
- `--all` also checks every transitive package from the lockfile.
- `file:`, `link:`, `workspace:`, git and URL dependencies are skipped (they have no registry publish date).

For every too-young dependency the output suggests the newest **safe version** that has already aged past
the cooldown.

## Example output

```
npm cooldown: 3 days — .npmrc min-release-age=3 (days)
  registry https://registry.npmjs.org/ · lockfile package-lock.json
Python cooldown: 5 days — pyproject.toml [tool.uv] exclude-newer = "5 days"
  registry https://pypi.org/ · no lockfile (versions resolved from specifiers)

STATUS       PACKAGE      VERSION   AGE   PUBLISHED   SAFE VERSION  DETAILS
✖ too young  boto3        1.43.118  1d    2026-10-22  1.43.114      pypi · spec >=1.30 · 3d left · requirements.txt
✔ ok         lodash       4.18.1    6mo   2026-04-01                npm · spec ^4.17.21
✔ ok         requests     2.32.3    2.4y  2024-05-29                pypi · spec ==2.32.3 · requirements.txt

3 checked · 1 too young
✖ Some dependency versions are younger than the cooldown.
```

## Options

```
npx cooldown-check [dir] [options]

  --min-age <dur>       Cooldown to enforce, overriding project config (7d, 48h, 2w, "3 days", P7D; bare number = days)
  --default-min-age <dur>  Cooldown used only when the project configures none (default 7d)
  --all                 Also check transitive dependencies from the lockfile
  --prod                Skip devDependencies and Python dev groups / dev requirement files
  --no-python           Only check npm dependencies
  --exclude <name>      Exempt a package (repeatable)
  --registry <url>      Override the npm registry
  --pypi-index <url>    Override the PyPI index (JSON API base, default https://pypi.org/)
  --concurrency <n>     Parallel registry requests (default 8)
  --timeout <sec>       Per-request timeout in seconds (default 20)
  --json                JSON output
  --fail-on-error       Exit 2 when a registry lookup fails
  --no-fail             Always exit 0 (report only)
  --verbose             Also list passing transitive packages
  --no-color            Disable colours (also honours NO_COLOR)
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every checked dependency is older than the cooldown (registry errors are reported but don't fail unless `--fail-on-error`) |
| `1` | At least one dependency is younger than the cooldown (or has no publish time) |
| `2` | Registry lookups failed with `--fail-on-error`, or invalid usage / nothing to check |

## CI usage

GitHub Actions:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npx --yes cooldown-check --min-age 7d
```

GitLab CI / any shell:

```bash
npx --yes cooldown-check --prod --json > cooldown-report.json
```

## Notes

- Requests go to public registry metadata endpoints; **no credentials are sent**. Private registries that
  require authentication are reported as lookup errors.
- Ages are computed from the registry's publish timestamp (`time` in npm packuments, upload time of the
  earliest file on PyPI).

## Related

- [Cooldown Lens for VS Code / Open VSX](https://marketplace.visualstudio.com/items?itemName=jonirafael.cooldown-lens) — the same checks inline in `package.json`, `requirements.txt` and `pyproject.toml`.
- Source: <https://github.com/jonirafael/cooldown-lens> (MIT)

Keywords: supply chain security, dependency cooldown, minimum release age, min-release-age, minimumReleaseAge,
npmMinimalAgeGate, uv exclude-newer, dependency age, package age check, npm, pnpm, yarn, bun, PyPI, pip.
