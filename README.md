# Kandev Augpool plugin

A native [Kandev](https://github.com/kdlbs/kandev) dashboard for
[Augpool](https://github.com/zeval/augpool) account usage and routing health.
It shows every account, the active/disabled/cooldown state, 30-day credits,
weighted score, local selections, and Analytics cache health.

When explicitly enabled, the dashboard can select, enable, disable, reweight,
import, remove, and export accounts. Every read and mutation goes through the
installed `augpool` CLI. The plugin never reads Augpool state or credential
files and never calls Augment Analytics directly.

## Trusted-host requirement

`management_enabled` is off by default. Enable it only for a single-user
Kandev instance reachable through loopback or a trusted private network.

Kandev's plugin webhook relay is currently reachable without a Kandev login.
Running an Augpool CLI command does not identify the browser that requested
it. Anyone able to reach the plugin endpoints can read account emails and
stats; after management is enabled, they can mutate the host-global pool and
export full credentials. Do not expose this plugin on an untrusted network.

## Requirements

- Kandev with native plugins enabled.
- Augpool `0.3.0` or newer, providing `stats --json` schema version 1 and the
  JSON mutation commands.
- A stable, global Augpool installation visible to the Kandev process. A
  project virtualenv that Kandev does not activate is insufficient.

Recommended Augpool install:

```sh
pipx install augpool
augpool --version
augpool stats --json
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `augpool_executable` | empty | Exact executable path. Empty checks Kandev's `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. Paths with spaces work; this is not shell syntax. |
| `augpool_home` | empty | Optional root passed as `augpool --home PATH`. Empty keeps Augpool's normal `AUGPOOL_HOME` / `~/.augpool` behavior. |
| `management_enabled` | `false` | Enables selection, edit, import, removal, and credential export on a trusted host. |

The settings page includes a live health card showing the resolved executable,
Augpool version, home, and read-only/management state.

## Dashboard behavior

- **Refresh usage** runs `augpool stats --json --refresh`. If Analytics fails,
  Augpool preserves the last usable cache and the dashboard displays its age
  plus the new refresh errors.
- **Select** runs `augpool use EMAIL --json`. It rewrites the configured
  Augment session for future launches; already-running ACP/CLI processes do
  not switch credentials.
- **Edit** enables/disables an account and sets a positive routing weight
  through `augpool update`.
- **Import** sends the share blob to `augpool import - --json` on stdin. The
  credential never appears in process arguments and is cleared from UI state
  after submission.
- **Remove** requires typing the complete account email.
- **Export** runs `augpool export EMAIL`, copies the returned base64url token
  once, then immediately discards it. The token is never rendered. On browsers
  without the Clipboard API, a temporary hidden textarea fallback is removed
  immediately; if both methods fail, use `augpool export EMAIL` in a trusted
  terminal.

An Augpool share blob is a full credential. Use disposable accounts for tests,
never paste a production blob into logs or issue trackers, and rotate anything
exposed accidentally.

## Architecture

```text
native Kandev page
  -> Kandev plugin webhook relay
  -> kandev-augpool Go subprocess
  -> exec.CommandContext(executable, args...)  # no shell
  -> installed augpool CLI
  -> Augpool pool/state/cache and Augment Analytics
```

Command output and request bodies are bounded. Refresh has a longer timeout
than local mutations. Plugin-originated actions are serialized to prevent
double-click races. Augpool remains the authority for account identity,
ranking, atomic persistence, credential validation, and Analytics caching.

## Develop

The Kandev backend SDK is currently consumed from a sibling monorepo checkout:

```text
work/
├── kandev/                    # github.com/kdlbs/kandev
└── kandev-plugin-augpool/     # this repo
```

Then run:

```sh
make test
make vet
make package-host
```

`make test` runs Go backend tests, dependency-free Node bundle tests, CSS
contract tests, and JavaScript syntax validation. `make package-host` writes
`kandev-augpool-0.1.1.tar.gz` for the current OS/architecture.

Install the package through **Settings → Plugins → Install plugin**, enable it,
then configure its executable/home. A direct local install is also possible:

```sh
curl -F package=@kandev-augpool-0.1.1.tar.gz \
  http://localhost:<kandev-port>/api/plugins/install
```

## Disposable smoke test

1. Verify missing-CLI, empty-pool, default-PATH, configured-path, and configured-home states.
2. Import two disposable share blobs and compare dashboard order with `augpool stats --json`.
3. Disable/re-enable, change weight, select active, and force an Analytics refresh.
4. Export a disposable account and compare clipboard content with CLI output; inspect the DOM/logs to confirm the token is absent.
5. Try incorrect/correct removal confirmation, then check phone, tablet, and desktop layouts.
6. Disable/re-enable the plugin and confirm its nav, route, and settings slot unregister/re-register cleanly.

## Release

The included workflows verify and cross-compile Linux/macOS amd64+arm64 and
Windows amd64 packages. Dispatch the release workflow from `main` or push a
matching SemVer tag. Marketplace registry inclusion should happen only after
the release exists and the trusted-host credential-export risk is reviewed.

## License

MIT — see [LICENSE](LICENSE).
