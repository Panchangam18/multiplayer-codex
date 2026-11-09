# Installation

## Requirements

- macOS 14 or newer. Downloaded previews currently target Apple silicon (arm64).
- Codex installed and signed in on each Mac. Tested desktop builds: `26.1027.30824` and `26.1103.60933`. Future versions can require adapter updates.
- Both devices on a LAN that permits Bonjour discovery and direct device-to-device connections. A shared Wi-Fi name alone is not sufficient.

No Node.js, npm, separate collaboration account, administrator installer, or hosted relay is required for the packaged app. Codex is not bundled.

## One-command install

Run on each Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/Panchangam18/multiplayer-codex/main/install.sh | bash
```

The [installer](https://github.com/Panchangam18/multiplayer-codex/blob/main/install.sh) downloads a pinned release, checks its SHA-256, verifies its app signature and identity, installs to `~/Applications`, and opens the companion. It requires no sudo, Node, or npm. It does not restart Codex, delete chats, remove quarantine, or change macOS security settings. The preview is still not notarized.

To inspect before running, download `install.sh`, read it, then run `bash install.sh`. Use `bash install.sh --no-open` to install without launching. Rerunning the command opens an already-installed matching version; for upgrades, quit the companion first. A replaced app is backed up beside the installation.

## Manual download

1. Open [GitHub Releases](https://github.com/Panchangam18/multiplayer-codex/releases). Select the Apple-silicon DMG and optionally its SHA256SUMS file.
2. To verify a downloaded DMG, run `shasum -a 256` on the file and compare its hash with the DMG entry in the release's checksum file. Check the exact version and filename.
3. Open the DMG and drag **Multiplayer Codex** to **Applications**. Eject the DMG, then open the copy in Applications. If you cannot write there, use your own `~/Applications` folder.

### Preview security warning

The initial release is **ad-hoc signed and not notarized**. A checksum or valid ad-hoc signature does not establish a verified developer identity or Apple's malware review. macOS may block a downloaded copy.

You can inspect and build the source instead. If you knowingly trust the downloaded preview, Apple's [per-app approval instructions](https://support.apple.com/en-us/102445) describe the **Privacy & Security → Open Anyway** flow after an attempted launch. Do not disable Gatekeeper globally, remove quarantine recursively, or override warnings that the app is damaged or contains malware. Managed Macs may prohibit exceptions.

A Developer ID–signed and notarized release remains future work; do not describe this preview as notarized.

## Connect

1. Launch the companion on both Macs. It lives in the menu bar, not the Dock.
2. Follow the welcome panel or choose **Enable Multiplayer** from the people icon. It is disabled when the status already says **Connected to Codex**.
3. If Codex is already connected, no restart is needed. Otherwise the companion requests permission before quitting and reopening Codex with a localhost integration port. Finish active agent work first.
4. Allow local-network access when prompted. Your Codex username/avatar is used automatically.
5. Right-click an idle local chat → **Multiplayer** → choose a nearby person. Compare the six-digit code on both screens, then accept on the recipient.

You plus four guests can share one chat. Pending invitations reserve places. **Done** closes the sheet without disconnecting anyone. Use **End sharing**, **Leave chat**, or **Remove** to change membership.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No people icon | Confirm the installed companion is open; check hidden menu-bar icons. |
| Not connected | Choose Enable Multiplayer. If it cannot reopen, finish active work and quit Codex normally before retrying. |
| Unsupported build | Compare your Codex version with the release notes. Don't modify or replace the Codex app bundle. |
| No nearby people | Both companions must be open; allow local-network access and wait for discovery. |
| Connecting fails | Keep the recipient awake. Guest Wi-Fi/client isolation may block traffic; use a suitable private LAN or actual wired network link. |
| Network changed | Wait for nearby discovery to refresh, then send a new invitation. Old sessions aren't automatically resumed. |
| Agent is working | Wait for the current turn before sending another message. Guest steering/queue mutations aren't supported. |
| Need logs | Open `~/Library/Application Support/Multiplayer Codex/companion.log`. Redact private information; never publish device keys, transcripts, or credentials. |

The integration port (`9337`) must stay localhost-only. Multiplayer's LAN listener uses a separate dynamically assigned TLS port. Do not expose the integration port to the network or disable your firewall globally.

## Updates and removal

Quit **Multiplayer Codex** and rerun the install command, or replace its installed app manually. Update both Macs and re-invite. This does not require replacing Codex or deleting its saved chats.

To uninstall, quit the companion and move it to the Trash. Quit and reopen Codex normally to remove the local integration port. Optional companion state remains in `~/Library/Application Support/Multiplayer Codex`; deleting that folder removes device identity, logs, and author metadata, not Codex history. Received history cannot be retroactively erased from collaborators' devices.

## Source build

See [Development](development.md). A build includes only companion source/runtime dependencies, never your installed Codex app, device keys, or transcripts. `npm run verify:mac` validates the generated bundle; it does not prove clean-machine launch approval.
