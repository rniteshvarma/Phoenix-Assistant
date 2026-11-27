import AppKit
import Combine

/// Menu bar flame + global hotkey.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: PhoenixController!
    private var statusItem: NSStatusItem!
    private var hotKey: HotKey?
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = PhoenixController()
        controller.start()

        hotKey = HotKey { [weak self] in
            Task { @MainActor in self?.controller.hotKeyPressed() }
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self
        updateIcon(controller.state.phase)
        controller.state.$phase
            .receive(on: RunLoop.main)
            .sink { [weak self] phase in self?.updateIcon(phase) }
            .store(in: &cancellables)
    }

    private func updateIcon(_ phase: Phase) {
        let active = [.listening, .thinking, .working, .waitingForYou].contains(phase)
        let name = phase == .offline ? "flame" : (active ? "flame.fill" : "flame")
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "Phoenix")
        image?.isTemplate = !active
        statusItem.button?.image = image
        statusItem.button?.contentTintColor = active ? NSColor(red: 1, green: 0.42, blue: 0.17, alpha: 1) : nil
    }

    @objc private func talk() { controller.hotKeyPressed() }
    @objc private func type() { controller.beginTyping() }
    @objc private func toggleWake() { controller.toggleWake() }
    @objc private func stop() { controller.stop() }
    @objc private func newConversation() { controller.newConversation() }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func resetStats() { controller.stats.reset() }
    @objc private func briefNow() { controller.briefNow() }
    @objc private func pauseProactive() { controller.pauseProactive(minutes: 60) }
    @objc private func toggleProactiveVoice() { controller.proactiveSpeaks.toggle() }

    /// Start (or restart) the background core installed by `phoenix autostart on`.
    @objc private func startCore() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/dev.phoenix.core"]
        try? task.run()
        task.waitUntilExit()
        if task.terminationStatus != 0 {
            let alert = NSAlert()
            alert.messageText = "Phoenix core isn't set up to start automatically yet"
            alert.informativeText = "Run this once in Terminal, from the Phoenix Assistant folder:\n\nnpm run phoenix -- autostart on"
            alert.runModal()
        }
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = controller.state
        let status = NSMenuItem(
            title: state.connected ? "Phoenix · \(state.phase.label.capitalized)" : "Phoenix core offline",
            action: nil, keyEquivalent: ""
        )
        status.isEnabled = false
        menu.addItem(status)
        if !state.connected {
            let start = NSMenuItem(title: "Start Phoenix core", action: #selector(startCore), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }
        menu.addItem(.separator())

        let talkItem = NSMenuItem(title: "Talk to Phoenix   \(hotKey?.label ?? "")", action: #selector(talk), keyEquivalent: "")
        talkItem.target = self
        menu.addItem(talkItem)

        let typeItem = NSMenuItem(title: "Type to Phoenix…", action: #selector(type), keyEquivalent: "")
        typeItem.target = self
        menu.addItem(typeItem)

        let wake = NSMenuItem(title: "Listen for “Phoenix, rise”", action: #selector(toggleWake), keyEquivalent: "")
        wake.target = self
        wake.state = state.wakeEnabled ? .on : .off
        wake.isEnabled = state.voiceReady
        menu.addItem(wake)

        let fresh = NSMenuItem(title: "New conversation", action: #selector(newConversation), keyEquivalent: "")
        fresh.target = self
        menu.addItem(fresh)

        let stopItem = NSMenuItem(title: "Stop Phoenix", action: #selector(stop), keyEquivalent: "")
        stopItem.target = self
        menu.addItem(stopItem)

        menu.addItem(.separator())
        let brief = NSMenuItem(title: "Brief me now", action: #selector(briefNow), keyEquivalent: "")
        brief.target = self
        menu.addItem(brief)
        let pause = NSMenuItem(title: "Pause proactive for 1 hour", action: #selector(pauseProactive), keyEquivalent: "")
        pause.target = self
        menu.addItem(pause)
        let voice = NSMenuItem(title: "Speak briefings and nudges", action: #selector(toggleProactiveVoice), keyEquivalent: "")
        voice.target = self
        voice.state = controller.proactiveSpeaks ? .on : .off
        menu.addItem(voice)

        menu.addItem(.separator())
        let testHeader = NSMenuItem(title: "Phase 1 exit test", action: nil, keyEquivalent: "")
        testHeader.isEnabled = false
        menu.addItem(testHeader)
        for line in [controller.stats.latencySummary, controller.stats.wakeSummary] {
            let item = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        let resetStats = NSMenuItem(title: "Reset measurements", action: #selector(resetStats), keyEquivalent: "")
        resetStats.target = self
        menu.addItem(resetStats)

        if !state.statusLine.isEmpty {
            menu.addItem(.separator())
            let note = NSMenuItem(title: state.statusLine, action: nil, keyEquivalent: "")
            note.isEnabled = false
            menu.addItem(note)
        }
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Phoenix", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }
}
