import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private var child: Process?
    private var statusItem: NSMenuItem!
    private var enableItem: NSMenuItem!
    private var timer: Timer?
    private var terminationSignals: [DispatchSourceSignal] = []
    private var connected = false
    private let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Multiplayer Codex")

    func applicationDidFinishLaunching(_ notification: Notification) {
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").count > 1 {
            NSApp.terminate(nil)
            return
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "person.2.circle", accessibilityDescription: "Multiplayer Codex")
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem = NSMenuItem(title: "Connecting…", action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        menu.addItem(.separator())
        enableItem = menu.addItem(withTitle: "Enable Multiplayer", action: #selector(connectCodex), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Multiplayer Codex", action: #selector(quit), keyEquivalent: "q")
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            terminationSignals.append(source)
        }
        startService()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refreshStatus() }
        if !UserDefaults.standard.bool(forKey: "hasSeenWelcome") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showWelcome() }
        }
    }

    private func startService() {
        guard let resources = Bundle.main.resourceURL else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("project/src/main.mjs").path]
        var environment = ProcessInfo.processInfo.environment
        environment["MULTIPLAYER_NAME"] = UserDefaults.standard.string(forKey: "displayName") ?? NSFullUserName()
        process.environment = environment
        let log = directory.appendingPathComponent("companion.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) {
            _ = try? handle.seekToEnd()
            process.standardOutput = handle
            process.standardError = handle
        }
        do { try process.run(); child = process }
        catch { statusItem.title = "Could not start: \(error.localizedDescription)" }
    }

    private func refreshStatus() {
        connected = false
        defer { enableItem.isEnabled = !connected }
        if child?.isRunning == false { statusItem.title = "Companion stopped — reopen to reconnect"; return }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("status.json")),
              let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              status["pid"] as? Int == Int(child?.processIdentifier ?? -1) else { return }
        switch status["state"] as? String {
        case "connected": connected = true; statusItem.title = "Connected to Codex"
        case "incompatible": statusItem.title = "Unsupported Codex version"
        default: statusItem.title = "Not connected"
        }
    }

    @objc private func connectCodex() {
        refreshStatus()
        if connected { return }
        let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex")
            ?? URL(fileURLWithPath: "/Applications/ChatGPT.app")
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            let alert = NSAlert(); alert.messageText = "Install the Codex desktop app first."; alert.runModal(); return
        }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
        if !running.isEmpty {
            let alert = NSAlert()
            alert.messageText = "Enable multiplayer in Codex?"
            alert.informativeText = "This quits and reopens Codex with a local integration port. Finish active agent work first. Your app and saved chats stay in place."
            alert.addButton(withTitle: "Quit and reopen")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            for app in running { app.terminate() }
        }
        waitForExit(appURL, attempts: 40)
    }

    private func waitForExit(_ appURL: URL, attempts: Int) {
        guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").isEmpty else {
            if attempts > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForExit(appURL, attempts: attempts - 1) } }
            else { statusItem.title = "Codex stayed open. Finish work and try again." }
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9337"]
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
            if let error { DispatchQueue.main.async { self.statusItem.title = error.localizedDescription } }
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
        alert.informativeText = "1. Install and open this companion on both Macs.\n2. Choose Enable Multiplayer from the people icon in the menu bar.\n3. Right-click a chat → Multiplayer, invite someone, and compare the pairing code.\n\nThis is an unofficial, experimental integration."
        alert.addButton(withTitle: wasConnected ? "Done" : "Enable Multiplayer")
        if !wasConnected { alert.addButton(withTitle: "Not now") }
        alert.addButton(withTitle: "Setup guide")
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        UserDefaults.standard.set(true, forKey: "hasSeenWelcome")
        if response == .alertFirstButtonReturn && !wasConnected { connectCodex() }
        else if response == (wasConnected ? .alertSecondButtonReturn : .alertThirdButtonReturn) { openProject() }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func menuWillOpen(_ menu: NSMenu) { refreshStatus() }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        child?.terminate()
        child?.waitUntilExit()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
