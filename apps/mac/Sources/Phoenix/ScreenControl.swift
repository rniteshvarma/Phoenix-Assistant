import AppKit
import ApplicationServices
import ScreenCaptureKit
import SwiftUI
import Vision

/// Phase 4b: Phoenix operating one app on the screen, for the core's screen session.
///
/// - Captures only the chosen app's windows (everything else is left out of the image).
/// - Reads the screenshot on this Mac (Vision) so the core can black out sensitive lines,
///   and draws those black boxes here, before the image leaves the app.
/// - Clicks only where the chosen app's own window is on top; types only when it's in front.
/// - Refuses payment buttons outright, and final buttons (Send, Submit, Delete…) unless the
///   user has just approved that step.
/// - Any mouse or keyboard input from the user hands control back immediately.
@MainActor
final class ScreenControl {
    private(set) var active = false
    private var target: NSRunningApplication?
    private var displayID: CGDirectDisplayID = CGMainDisplayID()
    private var bounds: CGRect = .zero      // the display, in global points (top-left origin)
    private var scale: CGFloat = 1          // screenshot pixels per point
    private var shots: [String: CGImage] = [:]
    private var monitor: Any?
    private var takenOver = false
    private var suspended = false
    private var lastPosted = Date.distantPast
    private var quietUntil = Date.distantPast
    private let overlay = LiveScreenOverlay()
    private let source = CGEventSource(stateID: .privateState)
    /// Tag on every event Phoenix posts, so its own clicks aren't mistaken for the user's.
    static let marker: Int64 = 0x50484F45

    /// Longest screenshot edge sent to Claude (keeps images inside the model's limits and cheap).
    static let maxEdge: CGFloat = 1568

    func run(_ tool: String, _ input: [String: Any]) async throws -> String {
        switch tool {
        case "screen_begin": return try await begin(app: input["app"] as? String ?? "")
        case "screen_capture": return try await capture()
        case "screen_image":
            return try image(id: input["id"] as? String ?? "", redact: Self.boxes(input["redact"]),
                             region: Self.box(input["region"]))
        case "screen_action":
            return try await action(input["name"] as? String ?? "", input["input"] as? [String: Any] ?? [:],
                                    armed: input["armed"] as? Bool ?? false)
        case "screen_end": end(); return "OK"
        default: throw PhoenixError("unknown screen action \(tool)")
        }
    }

    /// While an approval card is up, the user's clicks on it aren't a takeover.
    func suspendTakeover(_ on: Bool) {
        suspended = on
        // The user's hand is still on the mouse right after approving: give it a moment.
        if !on { quietUntil = Date().addingTimeInterval(2) }
        overlay.model.status = on ? "Waiting for your OK" : "Working"
    }

    // MARK: Begin / end

    private func begin(app name: String) async throws -> String {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw PhoenixError("Phoenix needs Screen Recording permission. Allow it in System Settings › Privacy & Security › Screen & System Audio Recording, then ask again.")
        }
        let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        guard AXIsProcessTrustedWithOptions(prompt) else {
            throw PhoenixError("Phoenix needs Accessibility permission to click and type. Allow it in System Settings › Privacy & Security › Accessibility, then ask again.")
        }
        if active { end() }

        let app = try await findOrLaunch(name)
        target = app
        app.activate()
        try await Task.sleep(nanoseconds: 700_000_000)

        // The display the app's biggest window is on.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 }
        guard let main = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw PhoenixError("\(app.localizedName ?? name) has no window open on screen")
        }
        let display = content.displays.first { CGDisplayBounds($0.displayID).intersects(main.frame) } ?? content.displays[0]
        displayID = display.displayID
        bounds = CGDisplayBounds(displayID)
        scale = min(1, Self.maxEdge / max(bounds.width, bounds.height))

        takenOver = false
        suspended = false
        active = true
        overlay.show(app: app.localizedName ?? name, displayID: displayID)
        monitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .scrollWheel, .keyDown]
        ) { [weak self] event in
            let ours = event.cgEvent?.getIntegerValueField(.eventSourceUserData) == ScreenControl.marker
            let isMove = event.type == .mouseMoved
            Task { @MainActor in self?.userInput(ours: ours, isMove: isMove) }
        }
        let size = ["app": app.localizedName ?? name, "width": Int(bounds.width * scale), "height": Int(bounds.height * scale)] as [String: Any]
        return String(data: try JSONSerialization.data(withJSONObject: size), encoding: .utf8) ?? "{}"
    }

    private func end() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        overlay.hide()
        shots = [:]
        active = false
        target = nil
    }

    private func userInput(ours: Bool, isMove: Bool) {
        guard active, !ours, !suspended, !takenOver, Date() >= quietUntil else { return }
        // Moving the cursor ourselves can produce a stray move event right after.
        if isMove && Date().timeIntervalSince(lastPosted) < 0.5 { return }
        takenOver = true
        overlay.model.status = "You took over"
    }

    private func findOrLaunch(_ name: String) async throws -> NSRunningApplication {
        func running() -> NSRunningApplication? {
            NSWorkspace.shared.runningApplications.first {
                $0.activationPolicy == .regular && ($0.localizedName ?? "").localizedCaseInsensitiveCompare(name) == .orderedSame
            }
        }
        if let app = running() { return app }
        let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
        let bundle = "\(name).app"
        guard let dir = dirs.first(where: { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir))?.contains { $0.localizedCaseInsensitiveCompare(bundle) == .orderedSame } == true
        }), let match = (try? FileManager.default.contentsOfDirectory(atPath: dir))?
            .first(where: { $0.localizedCaseInsensitiveCompare(bundle) == .orderedSame }) else {
            throw PhoenixError("no app called \(name) found on this Mac")
        }
        let config = NSWorkspace.OpenConfiguration()
        _ = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: dir).appendingPathComponent(match), configuration: config)
        for _ in 0..<40 {
            if let app = running() { try await Task.sleep(nanoseconds: 1_000_000_000); return app }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw PhoenixError("\(name) didn't open")
    }

    // MARK: Screenshots

    private func capture() async throws -> String {
        guard active, let target else { throw PhoenixError("no screen session") }
        if takenOver { throw PhoenixError("USER_TOOK_OVER") }
        overlay.model.status = "Looking"
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let app = content.applications.first(where: { $0.processID == target.processIdentifier }),
              let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw PhoenixError("\(target.localizedName ?? "the app") isn't on screen any more")
        }
        // Only the chosen app is drawn: other apps' windows never appear in the image.
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = Int(bounds.width * scale)
        config.height = Int(bounds.height * scale)
        config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        let lines = try await Task.detached(priority: .userInitiated) { try Self.recognize(image) }.value
        let id = UUID().uuidString
        shots = [id: image]  // keep only the latest
        let payload: [String: Any] = ["id": id, "width": image.width, "height": image.height, "lines": lines]
        return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8) ?? "{}"
    }

    /// Text lines and their boxes (pixels, top-left origin), read on this Mac.
    nonisolated static func recognize(_ image: CGImage) throws -> [[String: Any]] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let w = CGFloat(image.width), h = CGFloat(image.height)
        return (request.results ?? []).compactMap { obs in
            guard let text = obs.topCandidates(1).first?.string else { return nil }
            let b = obs.boundingBox
            return ["text": text, "box": [Int(b.minX * w), Int((1 - b.maxY) * h), Int(ceil(b.maxX * w)), Int(ceil((1 - b.minY) * h))]]
        }
    }

    private func image(id: String, redact: [CGRect], region: CGRect?) throws -> String {
        guard let shot = shots[id] else { throw PhoenixError("that screenshot is gone; take a new one") }
        let w = shot.width, h = shot.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw PhoenixError("couldn't prepare the image") }
        ctx.draw(shot, in: CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        for r in redact {  // boxes are top-left origin; the context is bottom-left
            ctx.fill(CGRect(x: r.minX - 4, y: CGFloat(h) - r.maxY - 4, width: r.width + 8, height: r.height + 8))
        }
        guard var out = ctx.makeImage() else { throw PhoenixError("couldn't prepare the image") }
        if let region, region.width > 4, region.height > 4, let crop = out.cropping(to: region) {
            // Zoom: the region at full detail, scaled to fit the usual screenshot size.
            let fit = min(CGFloat(w) / region.width, CGFloat(h) / region.height)
            let zw = Int(region.width * fit), zh = Int(region.height * fit)
            if let z = CGContext(data: nil, width: zw, height: zh, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                z.interpolationQuality = .high
                z.draw(crop, in: CGRect(x: 0, y: 0, width: zw, height: zh))
                if let zoomed = z.makeImage() { out = zoomed }
            }
        }
        guard let jpeg = NSBitmapImageRep(cgImage: out).representation(using: .jpeg, properties: [.compressionFactor: 0.75]) else {
            throw PhoenixError("couldn't encode the screenshot")
        }
        let payload = ["mediaType": "image/jpeg", "data": jpeg.base64EncodedString()]
        return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8) ?? "{}"
    }

    // MARK: Actions

    private func action(_ name: String, _ input: [String: Any], armed: Bool) async throws -> String {
        guard active, let target else { throw PhoenixError("no screen session") }
        if takenOver { throw PhoenixError("USER_TOOK_OVER") }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != target.processIdentifier {
            target.activate()
            try await Task.sleep(nanoseconds: 350_000_000)
        }
        let modifiers = Self.flags(input["text"] as? String)
        let point = Self.point(input["coordinate"]).map(toScreen)

        switch name {
        case "left_click", "right_click", "middle_click", "double_click", "triple_click":
            let p = point ?? currentLocation()
            try checkInside(p)
            try checkFinal(at: p, armed: armed)
            overlay.model.status = "Clicking"
            post(.mouseMoved, p, .left)
            let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
                name == "right_click" ? (.rightMouseDown, .rightMouseUp, .right)
                : name == "middle_click" ? (.otherMouseDown, .otherMouseUp, .center)
                : (.leftMouseDown, .leftMouseUp, .left)
            let count = name == "double_click" ? 2 : name == "triple_click" ? 3 : 1
            for n in 1...count {
                post(down, p, button, clicks: n, flags: modifiers)
                post(up, p, button, clicks: n, flags: modifiers)
            }
        case "left_click_drag":
            guard let end = point, let start = Self.point(input["start_coordinate"]).map(toScreen) else {
                throw PhoenixError("drag needs start_coordinate and coordinate")
            }
            try checkInside(start)
            try checkInside(end)
            overlay.model.status = "Dragging"
            post(.mouseMoved, start, .left)
            post(.leftMouseDown, start, .left, flags: modifiers)
            for i in 1...12 {
                let t = CGFloat(i) / 12
                post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t), .left, flags: modifiers)
                try await Task.sleep(nanoseconds: 15_000_000)
            }
            post(.leftMouseUp, end, .left, flags: modifiers)
        case "mouse_move":
            guard let p = point else { throw PhoenixError("mouse_move needs a coordinate") }
            try checkInside(p)
            post(.mouseMoved, p, .left)
        case "left_mouse_down", "left_mouse_up":
            let p = currentLocation()
            try checkInside(p)
            if name == "left_mouse_down" { try checkFinal(at: p, armed: armed) }
            post(name == "left_mouse_down" ? .leftMouseDown : .leftMouseUp, p, .left)
        case "cursor_position":
            let p = currentLocation()
            return "X=\(Int((p.x - bounds.minX) * scale)), Y=\(Int((p.y - bounds.minY) * scale))"
        case "scroll":
            let p = point ?? currentLocation()
            try checkInside(p)
            overlay.model.status = "Scrolling"
            post(.mouseMoved, p, .left)
            let amount = Int32(max(1, min(30, (input["scroll_amount"] as? NSNumber)?.intValue ?? 3)))
            let dir = input["scroll_direction"] as? String ?? "down"
            let dy: Int32 = dir == "up" ? amount : dir == "down" ? -amount : 0
            let dx: Int32 = dir == "left" ? amount : dir == "right" ? -amount : 0
            if let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                e.flags = modifiers
                mark(e).post(tap: .cghidEventTap)
            }
        case "type":
            try requireFront(target)
            overlay.model.status = "Typing"
            try await typeText(input["text"] as? String ?? "")
        case "key", "hold_key":
            try requireFront(target)
            let combo = input["text"] as? String ?? ""
            guard let (code, flags) = Self.parseKey(combo) else { throw PhoenixError("unknown key \(combo)") }
            if name == "hold_key" {
                key(code, down: true, flags: flags)
                let secs = min(10, max(0.1, (input["duration"] as? NSNumber)?.doubleValue ?? 1))
                try await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
                key(code, down: false, flags: flags)
            } else {
                let times = max(1, min(100, (input["repeat"] as? NSNumber)?.intValue ?? 1))
                for _ in 0..<times {
                    key(code, down: true, flags: flags)
                    key(code, down: false, flags: flags)
                }
            }
        default:
            throw PhoenixError("unsupported screen action \(name)")
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        overlay.model.status = "Working"
        return "OK"
    }

    private func toScreen(_ p: CGPoint) -> CGPoint {
        CGPoint(x: bounds.minX + p.x / scale, y: bounds.minY + p.y / scale)
    }

    private func currentLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// The topmost window under the point must belong to the chosen app.
    private func checkInside(_ p: CGPoint) throws {
        guard let target, bounds.contains(p) else { throw PhoenixError("OUTSIDE_APP: off the screen") }
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let mine = getpid()
        for w in list {
            guard let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: dict), rect.contains(p) else { continue }
            let owner = w[kCGWindowOwnerPID as String] as? pid_t ?? 0
            let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
            if alpha < 0.05 { continue }
            if owner == mine && overlay.owns(w[kCGWindowNumber as String] as? Int ?? -1) { continue }  // click-through overlay
            if owner == target.processIdentifier { return }
            throw PhoenixError("OUTSIDE_APP: \(w[kCGWindowOwnerName as String] as? String ?? "another window") is on top there")
        }
        throw PhoenixError("OUTSIDE_APP: nothing of the app there")
    }

    private static let money = try! NSRegularExpression(
        pattern: #"\b(pay|pay now|place order|buy now|purchase|proceed to pay|confirm and pay|add money|send money|transfer)\b"#,
        options: [.caseInsensitive])
    private static let final = try! NSRegularExpression(
        pattern: #"\b(send|submit|post|publish|share|book|confirm|delete|remove|trash|reply|checkout|order|request|unsubscribe|accept|sign out|log ?out)\b"#,
        options: [.caseInsensitive])

    /// Buttons that pay are never pressed; final buttons only right after the user's OK.
    private func checkFinal(at p: CGPoint, armed: Bool) throws {
        let label = Self.label(at: p)
        guard !label.isEmpty else { return }
        let range = NSRange(label.startIndex..., in: label)
        if Self.money.firstMatch(in: label, range: range) != nil { throw PhoenixError("MONEY_STEP: \(label)") }
        if !armed, Self.final.firstMatch(in: label, range: range) != nil { throw PhoenixError("NEEDS_CONFIRM: \(label)") }
    }

    /// What the control under the point says (its title, description or help), via Accessibility.
    private static func label(at p: CGPoint) -> String {
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &element) == .success,
              var current = element else { return "" }
        var parts: [String] = []
        for _ in 0..<3 {
            for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(current, attr as CFString, &value) == .success,
                   let s = value as? String, !s.isEmpty, s.count < 80 { parts.append(s) }
            }
            if !parts.isEmpty { break }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let next = parent, CFGetTypeID(next) == AXUIElementGetTypeID() else { break }
            current = next as! AXUIElement
        }
        return parts.joined(separator: " · ")
    }

    private func requireFront(_ app: NSRunningApplication) throws {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
            throw PhoenixError("NOT_FRONT: \(app.localizedName ?? "the app") isn't in front, so Phoenix won't type")
        }
    }

    // MARK: Event posting

    @discardableResult
    private func mark(_ e: CGEvent) -> CGEvent {
        e.setIntegerValueField(.eventSourceUserData, value: Self.marker)
        lastPosted = Date()
        return e
    }

    private func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int = 1, flags: CGEventFlags = []) {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        e.flags = flags
        mark(e).post(tap: .cghidEventTap)
    }

    private func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        e.flags = flags
        mark(e).post(tap: .cghidEventTap)
    }

    private func typeText(_ text: String) async throws {
        for (i, line) in text.components(separatedBy: "\n").enumerated() {
            if i > 0 { key(36, down: true, flags: []); key(36, down: false, flags: []) }
            var rest = Substring(line)
            while !rest.isEmpty {
                let chunk = Array(rest.prefix(16).utf16)
                rest = rest.dropFirst(16)
                for down in [true, false] {
                    guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                    e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                    mark(e).post(tap: .cghidEventTap)
                }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
        }
    }

    // MARK: Parsing

    static func point(_ value: Any?) -> CGPoint? {
        guard let a = value as? [NSNumber], a.count == 2 else { return nil }
        return CGPoint(x: a[0].doubleValue, y: a[1].doubleValue)
    }

    static func box(_ value: Any?) -> CGRect? {
        guard let a = value as? [NSNumber], a.count == 4 else { return nil }
        return CGRect(x: a[0].doubleValue, y: a[1].doubleValue,
                      width: a[2].doubleValue - a[0].doubleValue, height: a[3].doubleValue - a[1].doubleValue)
    }

    static func boxes(_ value: Any?) -> [CGRect] {
        (value as? [Any] ?? []).compactMap(box)
    }

    static func flags(_ text: String?) -> CGEventFlags {
        var f: CGEventFlags = []
        for part in (text ?? "").lowercased().split(separator: "+") {
            switch part.trimmingCharacters(in: .whitespaces) {
            case "shift": f.insert(.maskShift)
            case "ctrl", "control": f.insert(.maskControl)
            case "alt", "option", "opt": f.insert(.maskAlternate)
            case "cmd", "command", "super", "meta", "win": f.insert(.maskCommand)
            default: break
            }
        }
        return f
    }

    static func parseKey(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
        let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard let main = parts.last, !main.isEmpty else { return nil }
        let flags = Self.flags(parts.dropLast().joined(separator: "+"))
        guard let code = keyCodes[main.lowercased()] else { return nil }
        return (code, flags)
    }

    private static let keyCodes: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "return": 36, "enter": 36, "kp_enter": 76, "tab": 48, "space": 49, "backspace": 51, "delete": 51,
            "forwarddelete": 117, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
            "home": 115, "end": 119, "page_up": 116, "pageup": 116, "prior": 116, "page_down": 121, "pagedown": 121, "next": 121,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
            "f11": 103, "f12": 111, "minus": 27, "equal": 24, "comma": 43, "period": 47, "slash": 44, "semicolon": 41,
        ]
        let letters: [Character: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
            "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
            "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
            "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        ]
        for (ch, code) in letters { m[String(ch)] = code }
        return m
    }()
}

// MARK: - Live Screen Mode overlay

/// A glowing frame and a status pill while Phoenix is driving. Click-through, and never
/// in Phoenix's own screenshots (only the chosen app is captured).
@MainActor
final class LiveScreenOverlay {
    final class Model: ObservableObject {
        @Published var app = ""
        @Published var status = "Working"
    }

    let model = Model()
    private var window: NSWindow?

    func owns(_ number: Int) -> Bool { window?.windowNumber == number }

    func show(app: String, displayID: CGDirectDisplayID) {
        model.app = app
        model.status = "Starting"
        let screen = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        } ?? NSScreen.main ?? NSScreen.screens[0]
        let w = window ?? NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        w.setFrame(screen.frame, display: true)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.level = .statusBar
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        w.contentView = NSHostingView(rootView: LiveScreenView(model: model))
        w.orderFrontRegardless()
        window = w
    }

    func hide() {
        window?.orderOut(nil)
    }
}

struct LiveScreenView: View {
    @ObservedObject var model: LiveScreenOverlay.Model

    var body: some View {
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(LinearGradient(colors: [Fire.crimson, Fire.ember, Fire.gold], startPoint: .bottomLeading, endPoint: .topTrailing), lineWidth: 4)
                .shadow(color: Fire.ember.opacity(0.8), radius: 14)
                .padding(2)
            TimelineView(.animation) { timeline in
                let pulse = 0.55 + 0.45 * abs(sin(timeline.date.timeIntervalSinceReferenceDate * 2.4))
                HStack(spacing: 10) {
                    Circle().fill(Fire.ember).frame(width: 9, height: 9).opacity(pulse)
                        .shadow(color: Fire.ember, radius: 6)
                    Text("\(Persona.name) is using \(model.app)").font(.system(size: 13, weight: .semibold))
                    Text(model.status).font(.system(size: 12)).foregroundStyle(Fire.gold)
                    Text("· move the mouse or press a key to take over").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Fire.ember.opacity(0.6), lineWidth: 1))
            }
            .padding(.top, 34)
        }
    }
}
