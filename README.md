# Multiplayer Codex

**One Codex chat. Up to five people.** Invite nearby Macs into your existing chat, with shared messages, images, avatars, and typing indicators.

## Install

Run this in Terminal on **each Mac**:

```sh
curl -fsSL https://raw.githubusercontent.com/Panchangam18/multiplayer-codex/main/install.sh | bash
```

Downloads, verifies, installs to `~/Applications`, and opens the companion. **No sudo, Node, or extra account needed.** Requires Apple silicon, macOS 14+, and Codex installed.

[Inspect the installer](https://github.com/Panchangam18/multiplayer-codex/blob/main/install.sh) · [Download manually](https://github.com/Panchangam18/multiplayer-codex/releases)

## Share a chat

1. Click the **people icon** in the menu bar → **Enable Multiplayer**.
2. Right-click a chat → **Multiplayer** → invite someone on the same network.
3. Compare the pairing code and accept. Keep chatting in Codex as usual.

**Done** closes the picker. **End sharing** removes the collaboration UI.

## Good to know

- **Trust your collaborators.** Their prompts use the host’s agent, account, files, and permissions.
- **Local network only.** No relay or collaboration account. Guest/public Wi-Fi may block connections.
- **Unofficial preview, not notarized.** macOS may require [per-app approval](docs/installation.md#preview-security-warning). Codex updates can break compatibility.

[Setup & troubleshooting](docs/installation.md) · [Security](SECURITY.md) · [Development](docs/development.md) · [MIT license](LICENSE)
