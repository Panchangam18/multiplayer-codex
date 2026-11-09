import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native menu toggles two actions and disconnect stops only the companion service', { skip: process.platform !== 'darwin' }, context => {
  const directory = mkdtempSync(join(tmpdir(), 'multiplayer-menu-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = readFileSync('macos/MultiplayerCodex.swift', 'utf8').split('\nlet application = NSApplication.shared\n')[0]
    .replace('private func openCodexConnection() {', 'private func openCodexConnection() { preconditionFailure("Unexpected Codex restart") }\n    private func unusedOpenCodexConnection() {');
  const harness = `
final class LocalProbe: URLProtocol {
    static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        LocalProbe.requests += 1
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
extension AppDelegate {
    static func testMenu() throws {
        let suite = "multiplayer-menu-test-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let delegate = AppDelegate()
        delegate.preferences = preferences
        let menu = delegate.makeMenu()
        let actions = menu.items.filter { !$0.isSeparatorItem }
        precondition(actions.count == 2)
        precondition(actions.map { $0.title } == ["Connect to Codex", "Quit"])
        precondition(actions[0].action == #selector(toggleConnection))
        precondition(actions[1].action == #selector(quit))
        precondition(!menu.autoenablesItems)
        delegate.connected = true
        delegate.updateConnectionMenu()
        precondition(actions[0].title == "Disconnect to Codex")
        precondition(actions[0].isEnabled)
        delegate.connecting = true
        delegate.updateConnectionMenu()
        precondition(!actions[0].isEnabled)
        delegate.connecting = false
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        delegate.child = child
        delegate.disconnectCodex()
        precondition(!child.isRunning)
        precondition(delegate.child == nil)
        precondition(!delegate.connected)
        precondition(preferences.bool(forKey: "isDisconnected"))
        precondition(actions[0].title == "Connect to Codex")
        precondition(actions[0].isEnabled)
        delegate.refreshStatus()
        precondition(actions[0].title == "Connect to Codex")
        let resumedChild = Process()
        resumedChild.executableURL = URL(fileURLWithPath: "/bin/sleep")
        resumedChild.arguments = ["30"]
        try resumedChild.run()
        delegate.child = resumedChild
        defer { delegate.stopService() }
        URLProtocol.registerClass(LocalProbe.self)
        defer { URLProtocol.unregisterClass(LocalProbe.self) }
        delegate.connectCodex()
        let deadline = Date().addingTimeInterval(4)
        while delegate.connecting && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        precondition(!delegate.connecting)
        precondition(!preferences.bool(forKey: "isDisconnected"))
        precondition(resumedChild.isRunning)
        precondition(LocalProbe.requests == 1)
        print("PASS: two menu actions, connected toggle, busy guard, service shutdown, paused preference, stale-state guard, reconnect without restarting Codex")
    }
}
let application = NSApplication.shared
try AppDelegate.testMenu()
`;
  const path = join(directory, 'main.swift');
  const executable = join(directory, 'menu-test');
  writeFileSync(path, source + harness);
  const build = spawnSync('swiftc', ['-framework', 'AppKit', path, '-o', executable], { encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, build.stderr);
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: two menu actions/);
});
