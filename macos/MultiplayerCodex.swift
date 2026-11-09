import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private var child: Process?
    private var connectionItem: NSMenuItem!
    private var timer: Timer?
    private var terminationSignals: [DispatchSourceSignal] = []
    private var connected = false
    private var connecting = false
    private var preferences = UserDefaults.standard
    private let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Multiplayer Codex")

    func applicationDidFinishLaunching(_ notification: Notification) {
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").count > 1 {
            NSApp.terminate(nil)
            return
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "person.2.circle", accessibilityDescription: "Multiplayer Codex")
        item.menu = makeMenu()
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            terminationSignals.append(source)
        }
        if !preferences.bool(forKey: "isDisconnected") { _ = startService() }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refreshStatus() }
        if !preferences.bool(forKey: "hasSeenWelcome") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showWelcome() }
        }
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        connectionItem = menu.addItem(withTitle: "Connect to Codex", action: #selector(toggleConnection), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
        for menuItem in menu.items { menuItem.target = self }
        return menu
    }

    private func startService() -> Bool {
        if child?.isRunning == true { return true }
        guard let resources = Bundle.main.resourceURL else { return false }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("project/src/main.mjs").path]
        var environment = ProcessInfo.processInfo.environment
        environment["MULTIPLAYER_NAME"] = preferences.string(forKey: "displayName") ?? NSFullUserName()
        process.environment = environment
        let log = directory.appendingPathComponent("companion.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) {
            _ = try? handle.seekToEnd()
            process.standardOutput = handle
            process.standardError = handle
        }
        do { try process.run(); child = process; return true }
        catch { item?.button?.toolTip = "Could not start: \(error.localizedDescription)"; return false }
    }

    private func refreshStatus() {
        connected = false
        defer { updateConnectionMenu() }
        guard child?.isRunning == true else { return }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("status.json")),
              let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              status["pid"] as? Int == Int(child?.processIdentifier ?? -1) else { return }
        connected = status["state"] as? String == "connected"
        item?.button?.toolTip = status["state"] as? String == "incompatible" ? "Unsupported Codex version" : "Multiplayer Codex"
    }

    private func updateConnectionMenu() {
        connectionItem.title = connected ? "Disconnect to Codex" : "Connect to Codex"
        connectionItem.isEnabled = !connecting
    }

    @objc private func toggleConnection() {
        refreshStatus()
        if connected { disconnectCodex() }
        else { connectCodex() }
    }

    private func stopService() {
        if child?.isRunning == true {
            child?.terminate()
            child?.waitUntilExit()
        }
        child = nil
    }

    private func disconnectCodex() {
        connecting = false
        preferences.set(true, forKey: "isDisconnected")
        stopService()
        refreshStatus()
    }

    @objc private func connectCodex() {
        refreshStatus()
        guard !connected && !connecting else { return }
        preferences.set(false, forKey: "isDisconnected")
        guard startService() else { showError("Could not start Multiplayer Codex. Try reopening the companion."); return }
        connecting = true
        updateConnectionMenu()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:9337/json/version")!)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, self.connecting else { return }
                self.connecting = false
                self.refreshStatus()
                if self.connected || (response as? HTTPURLResponse)?.statusCode == 200 { return }
                self.openCodexConnection()
            }
        }.resume()
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func openCodexConnection() {
        let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex")
            ?? URL(fileURLWithPath: "/Applications/ChatGPT.app")
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            disconnectCodex()
            showError("Install the Codex desktop app first.")
            return
        }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
        if !running.isEmpty {
            let alert = NSAlert()
            alert.messageText = "Connect to Codex?"
            alert.informativeText = "This quits and reopens Codex with a local integration port. Finish active agent work first. Your app and saved chats stay in place."
            alert.addButton(withTitle: "Quit and reopen")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { disconnectCodex(); return }
            for app in running { app.terminate() }
        }
        waitForExit(appURL, attempts: 40)
    }

    private func waitForExit(_ appURL: URL, attempts: Int) {
        guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").isEmpty else {
            if attempts > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForExit(appURL, attempts: attempts - 1) } }
            else { showError("Codex stayed open. Finish work and try again.") }
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9337"]
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
            if let error { DispatchQueue.main.async { self.showError(error.localizedDescription) } }
        }
    }

    @objc private func openProject() {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("Getting Started.html") { NSWorkspace.shared.open(url) }
    }

    @objc private func showWelcome() {
        refreshStatus()
        let wasConnected = connected
        let alert = NSAlert()
        alert.messageText = wasConnected ? "You're ready to share" : "Welcome to Multiplayer Codex"
        alert.informativeText = "1. Install and open this companion on both Macs.\n2. Choose Connect to Codex from the people icon in the menu bar.\n3. Right-click a chat → Multiplayer, invite someone, and compare the pairing code.\n\nThis is an unofficial, experimental integration."
        alert.addButton(withTitle: wasConnected ? "Done" : "Connect to Codex")
        if !wasConnected { alert.addButton(withTitle: "Not now") }
        alert.addButton(withTitle: "Setup guide")
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        preferences.set(true, forKey: "hasSeenWelcome")
        if response == .alertFirstButtonReturn && !wasConnected { connectCodex() }
        else if response == (wasConnected ? .alertSecondButtonReturn : .alertThirdButtonReturn) { openProject() }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func menuWillOpen(_ menu: NSMenu) { refreshStatus() }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        stopService()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
