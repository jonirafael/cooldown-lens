# Changelog

## 0.2.0 — 2026-10-24

- **Python / PyPI support:** `requirements*.txt`, `constraints*.txt`, `requirements/*.txt` and `pyproject.toml`
  (PEP 621 dependencies and optional dependencies, PEP 735 dependency groups, Poetry). Publish dates from the PyPI JSON
  API, PEP 440 version ordering and specifiers, yanked releases never suggested, quick fix to `==<safe version>`.
- Python cooldown from uv `exclude-newer` (`uv.toml` / `[tool.uv]`, durations or absolute dates) and
  `exclude-newer-package`, else the new `cooldownLens.python.minimumReleaseAgeDays` setting.
- New command **Cooldown Lens: Check All Dependencies** scanning the whole workspace, with an output-channel report, a
  quick pick to jump to each finding and a workspace count in the status bar.
- New settings: `cooldownLens.python.enabled`, `cooldownLens.python.minimumReleaseAgeDays`, `cooldownLens.python.index`,
  `cooldownLens.checkAll.maxFiles`.
- Companion CLI [`cooldown-check`](cli/README.md) for CI (lockfile-aware, `--json`, non-zero exit code).
- Existing npm/pnpm/Yarn/Bun behaviour unchanged.

## 0.1.0 — 2026-10-19

- Initial release.
- Inline release age, cooldown diagnostics, hover details, CodeLens summary and status bar for `package.json`.
- Reads npm `min-release-age` (.npmrc, days), pnpm `minimumReleaseAge` (pnpm-workspace.yaml, minutes; .npmrc
  `minimum-release-age` for pnpm v10), Yarn `npmMinimalAgeGate` (.yarnrc.yml, duration), Bun
  `install.minimumReleaseAge` (bunfig.toml, seconds) and their exclude lists.
- Quick fix to the newest version that passes the cooldown.
- Cache with TTL, request de-duplication, concurrency limit, custom/scoped registries, offline mode.
