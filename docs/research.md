# Collaboration research and decisions

Researched November 8, 2026.

## The linked example

The [Dorsa post](https://x.com/dorsar/status/2074963064231952832) describes making Claude Code multiplayer, with people sharing a terminal and connecting separate Claudes. Direct X retrieval returned 403. The [FxTwitter public mirror](https://api.fxtwitter.com/status/2074963064231952832) returned the post text and video metadata. This establishes the advertised interaction, not the implementation protocol; no claim is made about its internal transport.

For this project, the useful product idea is a conversation where each human is recognizable and everyone can address the same agent. Connecting separate agents is a different feature and is outside this implementation.

## Existing patterns

| Project | Evidence | Implication here |
| --- | --- | --- |
| [Visual Studio Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity) | Attempts a direct connection, with cloud relay fallback; authenticated encrypted connections. Its [security documentation](https://learn.microsoft.com/en-ca/visualstudio/liveshare/reference/security) describes SSH encryption and host controls. | Keep execution at the host, with explicit access and removal. A relay is a later reachability feature. |
| [LocalSend](https://github.com/localsend/protocol) | Serverless local discovery, certificate fingerprints, HTTPS, and a prepare/accept stage before transfer. | Nearby discovery and an invitation acceptance step can avoid account setup. Discovery is not authorization. |
| [Zed collaboration](https://zed.dev/docs/collaboration/overview) | Integrated real-time collaboration, collaboration panel, sign-in, shared projects and visible participants. | Put collaboration in the existing work surface, with a persistent participant roster. |
| [Apple Bonjour](https://developer.apple.com/bonjour/) | Automatic local service discovery over standard IP protocols. | Use DNS-SD for a native-feeling nearby-computer picker on macOS. |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | Thread read/resume, turn start, streaming notifications, and approval handling. | Add human identity and room permissions around a single existing thread. Keep Codex as the runtime authority. |

## Chosen protocol

Bonjour discovery plus directly connected TLS 1.3 sockets. Both endpoints present self-signed device certificates. Discovery advertises only name, certificate fingerprint, port, and protocol version. An invitation binds a selected room to a pinned peer certificate. The host commits to a random nonce before the guest contributes fresh randomness; the host then reveals its nonce. Both people compare the resulting six-digit code, bound to both certificates, both nonces, and the invitation. This prevents an intermediary from choosing all inputs after learning the code and cheaply grinding a matching short fingerprint. Do not infer trust from a nearby device’s display name alone. This prototype protocol has not had an independent security review.

WebSockets would also carry these ordered events, but both peers already run native companions, so raw TLS avoids an HTTP listener and WebSocket upgrade layer. WebRTC would add signaling/ICE complexity without benefit for a LAN-only text stream. MultipeerConnectivity would be a reasonable Apple-only alternative, but an explicit TCP protocol keeps the room service independently testable and leaves a route to Windows/Linux companions later.

One host orders human prompts and executes agent turns. This avoids concurrent writes into one thread. Shared message editing is not offered, so a CRDT would solve a problem this interaction does not have. A future internet mode can carry the same room protocol through a mutually authenticated relay or a private network; it must preserve host scope, identity verification, and revocation.

## Local project findings

Read-only inspection of `attune`, `attune-app`, and `attunements/attunements/codex-multi-chat` established the working integration pattern: a localhost DevTools session, semantic sidebar selectors, `electronBridge.sendMessageFromView`, and `mcp-response` / `mcp-notification` events. The canvas attunement offered an example of using the existing desktop app-server rather than spawning a competing process for the same chat.

Read-only inspection of `bananad/apps/macos-companion` established a separate companion lifecycle and native menu-bar app pattern. Bananad’s Accessibility-based notch measures UI geometry and does not have the text/thread identity needed for this feature. Its hooks report activity, not a bidirectional multiplayer conversation protocol. This project therefore uses the renderer bridge for chat identity and messages, and a small native companion for launching and status.

The existing older Multiplayer prototype was a useful precedent for host execution and approval boundaries, but its SSH computer-sharing flow is broader than this request. No SSH enrollment, remote shell access, or code from that prototype is installed here. Attune and bananad working trees were left unchanged.
