# Native-chat architecture (0.2)

```text
Host native Codex sidebar/menu/chat       Guest native Codex sidebar/chat
  Multiplayer picker + author decoration   invitation + author decoration
  native outbound transport hook           native outbound transport hook
                  |                           |
           host companion <--- TLS 1.3 ---> guest companion
                  |
         existing Electron bridge (bypasses outbound hook)
                  |
         existing host app-server / selected thread
```

## Actual ASAR integration points

Read-only inspection of installed build `26.1027.30824` identified:

- `app-shared-7815d5a1a42a.js`: mutable transport `Lg` (export `WRt`), event bus `Vg` (export `zRt`), and context-menu component `Wxn` (export `OP`). The adapter imports the already-loaded module URL, prefers the inspected exports, and validates concrete property descriptors. Structural fallback excludes RPC proxies, whose property getters misleadingly return callable stubs for arbitrary names.
- The existing menu component accepts `getItems`/`items`. The adapter finds that component in the clicked sidebar row’s React ancestry, calls its real menu builder, preserves native item callbacks, roles, labels, icons, disabled states and submenus, and appends Multiplayer. It uses the same Electron `showContextMenu` API, not an HTML imitation. Unsupported menu ancestry leaves the original menu alone.
- `app-primary-95a0e6d83f1e.js`: semantic sidebar row ID/title/host attributes and `[data-thread-title]`. Presence is appended adjacent to that title; double-click remains the original rename action.
- `local-conversation-turn-79a3782322c3.js`: `[data-local-conversation-user-anchor]` and native message props `item`, `conversationId`, `toolActivityTurnKey`, `historyEntityKey`. Author decoration uses item/turn identity, never message-text matching.
- `app-initial-60f141238751.js`: native `thread/started` handling upserts the conversation store; `navigate-to-route` opens `/local/<id>`; the request client sends `mcp-request` through the mutable transport.
- `.vite/build/preload.js`: the frozen Electron bridge sends requests; the native event bus decodes responses, including chunked deliveries. No preload object mutation or bundle rewriting is needed.

These are private, version-sensitive contracts, not an official extension API. Static presence and successful adapter initialization do not prove the complete real-app flow.

## Native transcript projection

`renderer/native.js` hooks only local MCP requests for active shared threads. Unrelated chats and ordinary app messages pass through unchanged. Before a guest joins, host requests remain untouched. The existing composer stays mounted and visible for the entire session. There is no custom chat timeline or text editor.

On acceptance, a guest uses the random room UUID as a local alias, distinct from the host’s thread ID. A synthetic native `thread/started` notification inserts its metadata and native navigation opens it. Native thread-list results include the alias. Reads/resume/history pagination for that alias go through a strict invited-thread RPC allowlist to the host. Results and live thread-scoped events are rewritten only at ID fields and delivered to the native event bus. User and agent text is never rewritten. The guest does not start a local model run.

Disconnected aliases remain tombstoned while the adapter is installed: requests fail explicitly instead of falling through to the guest's local server. Reinviting creates a new session alias. Native UI/cache entries are not durable room membership, and removing access does not erase data already received.

### Host-managed builds

In `26.1103.60933`, renderer requests such as `resumeConversation` use a native RPC client backed by the main-process manager. Intercepting renderer MCP messages alone does not intercept these calls. `renderer/managed.js` wraps the local client's RPC service and router in the existing AppScope, preserving ordinary-chat calls. It reuses the cached `V7mA` native manager/target and `Fkn8` RPC classes rather than implementing a separate transcript or composer.

Each accepted guest alias is hydrated from an authorized host `thread/read` into a separate, memory-only native manager. Native subscriptions combine shared sidebar summaries with ordinary summaries and direct guest transcript subscriptions to this projection. Incoming events use the bundled notification reducer; events arriving during hydration are bounded and reconciled using its resume buffer. Guest resume never calls the guest's local app-server. The shared native turn coordinator sends plain text through the companion to the authoritative host; unsupported guest mutations fail rather than falling through. The projection has no local model/tool executor, filesystem writes, or account services. Newer-build shared sends use the host thread's existing configuration, not guest composer overrides.

The adapter restores the prior client/router on cleanup. This is an experimental, private integration; the isolated component smoke test is not proof of the real React subscriptions, complete native UX, or physical-network collaboration.

Guest read/unread operations use the native projection's read-state methods and a local subscribed store with server synchronization disabled. Bulk read operations split shared aliases from ordinary thread IDs, so guest aliases never reach the local main-process manager and reading a guest chat never marks the host's chat read.

The focused, visible native composer reports its guest alias to the projection on focus, visibility, and periodic checks. The projection clears that chat's native read state after notifications and unread callbacks; unfocused/background chats retain unread state. Native active-conversation leases are retained instead of being replaced by no-ops.

Typing resolves the active conversation from the visible composer's native React scope before falling back to navigation events or the URL. This supports native in-memory navigation and a chat already open before attachment. Known new-chat scopes override stale routes. Typing bubbles are fixed above the composer rather than inserted into its potentially clipped layout. Message avatars use existing native user-message IDs and participant profile metadata, never text matching, and decorate only other participants' messages.

## Authority and authors

The accepted TLS connection determines the guest identity. Every guest request is bound to its invited room and exact host thread. Reads have explicit allowed parameter lists. Resume cannot replace history or change permission settings. Guest text starts omit model, working-directory, and approval overrides; they use the host thread’s existing settings. The host’s own native start parameters are retained.

The newer native composer also reads `getFollowUpContext` before reaching its turn coordinator. That read is served from the isolated guest projection, never the guest's main-process manager. A bounded `clientUserMessageId` can accompany guest text to correlate native submission/display acknowledgement; it does not grant model, tool, or permission overrides. Host `thread/resume` metadata establishes the shared model/effort, with successful host start overrides updating it. The guest's native projection uses those fields, and its existing model button is decorated as host-controlled and read-only.

Typing is ephemeral, membership-bound metadata. Renderer input sends only an active boolean and room ID, not editor contents. The host assigns the member identity from the accepted connection, throttles refreshes, expires presence after five seconds, and clears it on submission, removal, or room closure. Existing room sending states also produce the animated bubble. `renderer/presence.js` inserts a small status bubble beside the native composer without replacing it and restores model-button attributes when leaving a shared chat or quitting.

`Room` stores author metadata by server turn and user-item ID. Participants’ actual inputs remain ordinary text user messages, without name prefixes. On each computer, only messages by someone else receive a corner avatar with a pastel ring and a hover-only name. There is no message tint or persistent name label. Participant avatars appear beside the sidebar title after acceptance.

Primary native user messages can be synthesized from turn input without a `searchItemId`. Their author is resolved using the enclosing component's `conversationId` and server `turnId`, or the native NUL-separated tool-activity key. Child item identity is still used where present. Bounded decoration diagnostic counts (anchors, marked bubbles, known item/turn authors) are logged without message contents or identifiers.

## User images

Local clipboard paths are machine-specific. `src/images.mjs` replaces user-message image references in authorized host history/events with random room-local image tokens. Only accepted members can fetch those tokens in 192 KiB chunks; no network API accepts a host filesystem path. The guest reconstructs inline raster URLs in memory before passing history/events to the native renderer. Events remain ordered during image transfer. Image bytes are validated by raster signature and bounded to 16 MiB per image and 64 MiB per room cache. Missing files produce an unavailable image, not a failed chat resume.

Guest composer images are read on the guest machine, uploaded in bounded chunks, and converted to inline image inputs by the host. Uploads are member-scoped, incomplete uploads expire after 30 seconds or removal, and a peer cannot use this to read arbitrary host paths. Guest model/permission overrides remain stripped. Room closure discards image caches. Authoritative host history retains normal image inputs, not multiplayer tokens or collaborator names.

Native text starts return the actual host turn result, not a synthetic success. This revision rejects a second start while a turn is active rather than allowing a timed-out queued request to execute later. Steering and native queue mutations are explicitly unsupported. The host’s native interrupt and approval paths remain intact. The lower-level room queue remains covered by tests but is not exposed by the native composer adapter.

## Pairing and transport

`renderer/profile.js` reads the footer component’s `sidebarFooter.profileIdentity`, preferring `username` to `displayName`. It copies the rendered avatar’s initials/colors or a 64px PNG from an already-loaded image, without forwarding URLs or reading authentication state. Nearby discovery carries small display fields; a certificate-pinned `profile-request` fetches a bounded sanitized avatar before invitations, but grants no transcript or RPC access. Profile changes propagate to the discovery advertisement and current room members. Header, picker, invitation and presence avatars use this metadata. PNG dimensions/payloads and CSS colors are bounded and validated.

Bonjour advertises `_codex-mp._tcp` protocol version 2. Version 1 companions are not displayed. Direct TLS 1.3 uses persistent certificates on both endpoints and a pinned discovered recipient fingerprint. An invitation carries title/name, but no transcript. Commitment/challenge/reveal nonces bind the displayed code to the invitation and both identities. The recipient compares codes and explicitly accepts; invitations expire after two minutes.

After acceptance, room snapshots convey presence/author metadata; `native-request`/`native-result` relay allowed requests; `native-event` conveys only notifications for the selected thread. Revocation closes the connection and denies pending reads after membership changes. Host work already running is not interrupted. A prompt can still exercise any tool powers granted by the host’s existing settings: this is not a sandbox around the guest.

Frames are limited to 4 MiB, with heartbeat/backpressure/connection/request limits. Oversized history or tool responses can terminate the session. Neither CDP nor arbitrary app-server RPC is exposed to the LAN.

## Lifecycle

The Swift menu-bar companion starts the Node service. Connect explicitly asks before quitting/reopening Codex with a localhost DevTools port. Updating the injected code can instead restart only the companion while Codex stays running. Quit removes hooks and decoration and closes shares; the app bundle, authentication, and configuration are untouched. A normal Codex restart removes the debugging endpoint. A crash may leave an orphaned hook until restart.
