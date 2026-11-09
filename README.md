# Multiplayer Codex

**One Codex chat. Up to five people.**

An unofficial macOS companion that makes an existing Codex conversation collaborative. Right-click a chat, choose **Multiplayer**, and invite a nearby Mac. Everyone uses the original chat and composer; one agent runs on the host.

[Download the preview](https://github.com/Panchangam18/multiplayer-codex/releases) · [Installation](docs/installation.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

> **Experimental, LAN-only, and not affiliated with OpenAI.** Uses private Codex interfaces, not an official extension API. The initial download is ad-hoc signed and **not notarized**. Guest/public Wi-Fi may block collaboration even when both Macs have internet access.

## What it does

- Native sidebar context-menu integration—no separate chat app or replacement composer.
- Nearby-device picker, explicit invitations, and a six-digit code to compare.
- **Five people total:** one host and four guests.
- Original profile avatars on collaborators' messages; hover for their names.
- Live typing indicators and shared text/image messages.
- Host-controlled model, execution, tools, and approvals.
- Temporary collaboration UI: stop sharing and the host's chat looks normal again.
- No relay server, cloud account, analytics, or transcript upload to a hosted collaboration service.

## Install and share

Requires **macOS 14+**, Codex on both Macs, and a network that permits local device-to-device connections. The preview download is for **Apple silicon (arm64)**; Intel users can build from source, but Intel has not been physically validated.

1. Download the DMG from [Releases](https://github.com/Panchangam18/multiplayer-codex/releases), open it, and drag **Multiplayer Codex** to **Applications** on both Macs.
2. Launch the installed companion. Use its people icon in the menu bar → **Connect Codex…**. If it asks to reopen Codex, finish active agent work before confirming.
3. Allow local-network access if prompted.
4. Right-click an idle local chat → **Multiplayer**, then select a nearby person.
5. Compare the pairing codes on both screens. The recipient checks the confirmation and accepts.
6. Keep using Codex. **Done** closes the sharing sheet; **End sharing** disconnects collaborators.

See the [installation guide](docs/installation.md) for preview security prompts, updates, network troubleshooting, and uninstalling.

### Important: whose computer runs the agent?

**The host's.** Collaborators send ordinary user messages to the host's existing agent. The host's Codex account, tools, filesystem access, and permission settings apply. This is **not a sandbox** around collaborators' prompts. Invite only people you trust.

No sender names are inserted into prompts or saved transcript text. Guests cannot approve host tools or select a different model. Removing a guest prevents future access, but cannot erase history already received.

## Build from source

Requires Node.js 22+, macOS 14+, and Xcode command-line tools. Use an official Node distribution with its bundled LICENSE; the build checks that the runtime has no non-system dynamic-library dependencies.

```sh
git clone https://github.com/Panchangam18/multiplayer-codex.git
cd multiplayer-codex
npm ci
npm test
npm run check
npm run build:mac
npm run verify:mac
```

Builds an app, architecture-labeled ZIP and DMG, and SHA-256 checksums in `dist/`. Recipients do not need Node or npm. The build is ad-hoc signed; it does not imply Developer ID signing or notarization. To build while the companion is running, set `OUTPUT_DIR` to a separate directory.

For development, `npm start` runs the service without the menu-bar app. The native companion's Connect action opens Codex with a **localhost-only** integration port. Do not forward that port or bind it to a public interface.

| Variable | Purpose |
| --- | --- |
| `MULTIPLAYER_NAME` | Development fallback display name |
| `MULTIPLAYER_HOME` | Separate identity/state directory for tests |
| `MULTIPLAYER_CODEX_PORT` | Local integration port (default 9337) |
| `CODEX_APP` | Installed app path for `npm run diagnose` |
| `OUTPUT_DIR` | Alternate packaging output directory |

## Compatibility and verification

The adapters target Codex desktop builds `26.1027.30824` and `26.1103.60933`. The installed app may be named ChatGPT; identification uses `com.openai.codex`. Unrecognized private service contracts fail closed. Future Codex updates may require adapter changes.

Physical two-Mac use has exercised invitations, native messaging, images, avatars, typing, unread handling, and teardown. Five-person behavior is covered by six isolated Electron fixture windows with real TLS and a simulated agent—not five physical Macs. See [verification](docs/verification.md) for commands and limitations.

## Privacy and connection design

Bonjour discovers nearby devices; pinned TLS 1.3 connections carry ordered messages directly between companions. Pairing binds the invitation to the two device identities. A nearby name is display metadata, not proof of identity—always compare codes.

Nearby devices receive your Codex display name and bounded avatar thumbnail, not account tokens or email fields. Copying an already-displayed avatar can require a bounded, unauthenticated HTTPS fetch from an allowlisted avatar host. Unsent draft text is never transmitted.

Device keys, author attribution, status, and logs live in `~/Library/Application Support/Multiplayer Codex`. Authoritative chats remain in Codex's host history; recipients may cache displayed data. No Codex binary, extracted proprietary assets, credentials, or personal transcripts are distributed here.

## Current boundaries

- LAN/IPv4 only; no internet relay. Guest Wi-Fi, VPNs, and client isolation can block connectivity.
- Network changes refresh discovery, but sharing requires a fresh invitation. Prompts are never automatically replayed.
- One attached Codex window per companion. Don't send into the same shared thread from another window or CLI.
- Wait for the active turn to finish before sending. Guest steering and native queue mutations are not supported.
- Text and PNG/JPEG/GIF/WebP images: up to 16 MiB each, eight per submission, and a 64 MiB shared-room image cache.
- Host-local file navigation and other machine-local UI integrations are not forwarded.
- This prototype's pairing protocol has not had an independent security audit.

## License

MIT. See [LICENSE](LICENSE). Packaged Node.js and dependencies retain their own licenses. Codex is a separate product and is not included.
