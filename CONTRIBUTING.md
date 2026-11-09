# Contributing

Use Node.js 22 or newer. Run `npm ci`, `npm test`, and `npm run check` before opening a pull request. macOS packaging additionally requires macOS 14+ and Xcode command-line tools.

Preserve the native composer, context menu, timeline, model controls, and ordinary behavior in unshared chats. Collaboration decorations must disappear on teardown. Never add sender names to agent prompts or persistent transcripts.

Network changes must retain certificate pinning, explicit invitation acceptance, host-owned execution, thread scoping, and revocation. Keep the product LAN-only; do not introduce a hosted relay or authentication service without a separate design discussion.

Use isolated fixtures for UI automation. Local Codex ASARs are optional inputs to compatibility checks; never commit or distribute Codex binaries or extracted proprietary assets. See [verification](docs/verification.md) for test commands and evidence boundaries.

Do not commit `.local/`, generated builds, screenshots of real chats, device identities, logs, private IP inventories, or credentials.
