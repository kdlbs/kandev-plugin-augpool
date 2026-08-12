# Changelog

## [0.1.6] - 2026-08-12

### Added

- Add 30-day local session and current-month credit balance graphs.
- Split daily session bars by account with a color-coded totals legend.
- Show configured weight-share targets while Augpool uses auto routing.

### Changed

- Support Augpool 0.3 stats schema version 2 and routing modes.
- Correct credit-period copy from 30-day to current UTC month.
- Keep account notes from `usage --json` out of browser responses.

## [0.1.5] - 2026-08-10

### Changed

- fix(ui): polish settings and account controls (d13b845)


## [0.1.4] - 2026-08-10

### Changed

- fix(ui): refresh settings state and card layout (cd905c1)


## [0.1.3] - 2026-08-10

### Changed

- fix(ui): align account table columns (dcbb28e)


## [0.1.2] - 2026-08-10

### Changed

- fix: require Augpool 0.3 machine API (6db61fb)


## [0.1.1] - 2026-08-07

### Fixed

- Place Augpool inside Kandev's Integrations navigation section.
- Find common pipx and Homebrew Augpool installations when the Kandev process PATH is minimal.
- Give an actionable absolute-path remedy when the Augpool CLI remains unavailable.

## [0.1.0] - 2026-08-06

### Added

- Native Augpool stats dashboard with cache and CLI health.
- Trusted-host account selection, enable/disable, weight, import, removal, and clipboard export controls.
- Bounded shell-free Augpool CLI adapter and versioned stats schema validation.
