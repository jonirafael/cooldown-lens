# Changelog

## 0.1.0 — 2026-10-19

- Initial release.
- Inline release age, cooldown diagnostics, hover details, CodeLens summary and status bar for `package.json`.
- Reads npm `min-release-age` (.npmrc, days), pnpm `minimumReleaseAge` (pnpm-workspace.yaml, minutes; .npmrc
  `minimum-release-age` for pnpm v10), Yarn `npmMinimalAgeGate` (.yarnrc.yml, duration), Bun
  `install.minimumReleaseAge` (bunfig.toml, seconds) and their exclude lists.
- Quick fix to the newest version that passes the cooldown.
- Cache with TTL, request de-duplication, concurrency limit, custom/scoped registries, offline mode.
