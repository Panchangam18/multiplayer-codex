# Development

Requires macOS 14+, Node.js 22+, and Xcode command-line tools. Use an official Node distribution with its bundled LICENSE; packaging rejects non-system runtime dependencies.

```sh
git clone https://github.com/Panchangam18/multiplayer-codex.git
cd multiplayer-codex
npm ci
npm test
npm run check
npm run build:mac
npm run verify:mac
```

Builds an app, architecture-labeled ZIP and DMG, and SHA-256 checksums in `dist/`. Intel source builds are possible but unverified. Recipients need neither Node nor npm. Builds are ad-hoc signed, not notarized. Set `OUTPUT_DIR` to a separate directory when building while the companion runs.

`npm start` runs the service without the menu-bar app. The companion's Enable Multiplayer action opens Codex with a localhost-only integration port. Never expose or forward that port.

| Variable | Purpose |
| --- | --- |
| `MULTIPLAYER_NAME` | Development fallback display name |
| `MULTIPLAYER_HOME` | Separate identity/state directory for tests |
| `MULTIPLAYER_CODEX_PORT` | Local integration port (default 9337) |
| `CODEX_APP` | Installed app path for `npm run diagnose` |
| `OUTPUT_DIR` | Alternate packaging output directory |

## Runtime boundaries

- Five people total: one host and four guests. Five-person UI tests use isolated fixtures, not five physical Macs.
- One attached Codex window per companion. Don't send into the same shared thread from another window or CLI.
- Wait for active turns before sending. Guest steering and native queue mutations are unsupported.
- PNG/JPEG/GIF/WebP images: 16 MiB each, eight per submission, 64 MiB room cache.
- LAN/IPv4 only. Network changes need a fresh invitation; prompts are never automatically replayed.
- Host-local file navigation and other machine-local UI integrations are not forwarded.
- Authoritative chats stay in Codex's host history. Device keys, attribution, status, and logs live in `~/Library/Application Support/Multiplayer Codex`. Recipients may cache received data.

See [architecture](architecture.md), [verification](verification.md), and [contribution guidelines](../CONTRIBUTING.md).

## Publishing installer updates

Publish the versioned ZIP first, then update `version` and its pinned ZIP SHA-256 in `install.sh`. Never replace an existing release asset with different bytes. Run installer tests and a real download/install in an isolated home directory before pushing. Checksums verify the chosen artifact, not a verified developer identity or notarization.
