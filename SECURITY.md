# Security

This is an experimental, unofficial Codex companion. Its custom pairing protocol and private renderer integration have not had an independent security review.

## Trust boundary

- Invite only people you trust. Their prompts run on the host's computer, with the host's Codex account, tools, files, and existing permissions. This is not a sandbox.
- Compare the six-digit code on both screens before accepting. A display name or avatar does not establish identity.
- Invitations reveal the chat title but not its transcript before acceptance. Accepted guests can read the selected conversation and send prompts. Revocation cannot erase data already received.
- The localhost integration port controls the Codex renderer. Do not expose or forward port 9337 to another machine. Quit and reopen Codex normally to disable it.
- Nearby devices receive display names and bounded avatars. Draft text is not transmitted. The companion does not copy Codex authentication tokens.
- No cloud relay, analytics, or hosted account service is used. The selected profile image may be fetched from an allowlisted HTTPS host without cookies or authentication headers.

## Reporting

Use the repository's **Security → Report a vulnerability** option for sensitive reports. Do not post device keys, transcripts, account tokens, or raw logs in public issues. If private reporting is unavailable, open an issue requesting a private reporting channel without vulnerability details.

Only the latest preview is maintained. Codex updates can change private interfaces; an incompatible build may require an adapter update.
