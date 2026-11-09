# Verification

## Automated checks

```sh
npm ci
npm test
npm run check
npm run build:mac
npm run verify:mac
```

The test suite covers real TLS connections, certificate pinning, invitation consent/expiry, five-person capacity including pending invitations, thread scoping, revocation, image bounds, profile sanitization, author attribution, native-renderer fixtures, cleanup, and Wi-Fi discovery refresh. Installer tests use isolated homes and mocked downloads to check platform guards, checksum/signature failures, app identity, repeat installs, backups, and rollback.

## UI fixtures

Supply an Electron executable from your own development environment:

```sh
node scripts/smoke-desktop.mjs /path/to/Electron
node scripts/smoke-five-desktop.mjs /path/to/Electron
node scripts/smoke-discovery.mjs
```

The two-window smoke first verifies visible connection failure and retry, then invitation/acceptance, native composers, streamed messages, images, avatars, and teardown. The five-person smoke creates six isolated windows, connects five, checks four other participants' avatars/typing indicators per viewer, sends from everyone to one host, blocks the sixth, replaces a departed member, and checks cleanup. Screenshots and reports go into ignored `test-results/`.

These tests use real TLS but simulated native chat/agent fixtures. Local discovery tests exercise actual Bonjour sockets, including rebuilding them after a simulated interface change; they are not physical Wi-Fi roaming tests.

## Optional installed-build checks

```sh
npm run diagnose
node scripts/smoke-managed.mjs /path/to/your/installed/app.asar
```

The manager smoke loads selected modules from a locally supplied Codex ASAR. No Codex files are included in this repository. It validates the projection adapter against that build, not the whole real desktop UI.

## Physical testing

Two Apple-silicon Macs have exercised native chat sharing, messages, images, profile avatars, typing, unread behavior, and teardown. After returning from an isolated guest network to a private LAN, both devices discovered each other and passed pinned TLS profile requests in both directions.

Five physical Macs, Intel Macs, arbitrary Codex versions, and clean-machine Gatekeeper approval have not been validated. The initial release is an unnotarized preview, not a broadly certified production release.

## Packaging checks

The build creates an app from a fresh staging directory, includes the Node runtime license and dependency licenses, excludes local state, and emits checksums for ZIP/DMG assets. Verification checks the app signature, plist, resources, bundled runtime/dependency loading, and absence of private runtime files. A valid ad-hoc signature is not notarization.

Before publishing a release, additionally mount the DMG, verify the app and Applications shortcut, and launch the packaged companion without restarting Codex or sending messages automatically.
