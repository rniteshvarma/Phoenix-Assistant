import AppKit

// Menu bar app: no Dock icon (LSUIElement), lives in the status bar and the Summon Bar.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
