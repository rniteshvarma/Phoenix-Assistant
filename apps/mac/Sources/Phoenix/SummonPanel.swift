import AppKit
import SwiftUI

/// Floating, non-activating panel (like Spotlight), so Phoenix can appear over any app
/// without stealing focus unless you type. Drag it by its top row; it remembers where
/// you put it and always stays fully on screen as it grows.
final class SummonPanel: NSPanel {
    private static let originKey = "summonPanelOrigin"
    private var observers: [NSObjectProtocol] = []
    private var placingProgrammatically = false

    init<Content: View>(rootView: Content) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 160),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false

        let host = NSHostingController(rootView: rootView)
        host.sizingOptions = [.preferredContentSize]
        host.view.wantsLayer = true
        host.view.layer?.backgroundColor = .clear
        contentViewController = host

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didResizeNotification, object: self, queue: .main) { [weak self] _ in
            self?.keepOnScreen()
        })
        observers.append(center.addObserver(forName: NSWindow.didMoveNotification, object: self, queue: .main) { [weak self] _ in
            guard let self, !self.placingProgrammatically else { return }
            UserDefaults.standard.set(NSStringFromPoint(self.frame.origin), forKey: Self.originKey)
        })
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Show the panel. If it isn't on screen yet, it fades in exactly where it will stay.
    func present(focus: Bool) {
        if !isVisible {
            placeInitially()
            keepOnScreen()
            alphaValue = 0
        }
        ignoresMouseEvents = false
        if focus {
            NSApp.activate(ignoringOtherApps: true)
            makeKeyAndOrderFront(nil)
        } else {
            orderFrontRegardless()
        }
        if alphaValue < 1 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.28
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                animator().alphaValue = 1
            }
        }
        keepOnScreen()
    }

    /// Put the panel in place and lay it out, but keep it invisible and click-through, so the
    /// summon effect can be aimed at its real position before it fades in.
    func prepareInvisibly() {
        if !isVisible {
            placeInitially()
        }
        alphaValue = 0
        ignoresMouseEvents = true
        orderFrontRegardless()
        contentViewController?.view.layoutSubtreeIfNeeded()
        keepOnScreen()
    }

    /// Convert a point inside the panel (top-left origin) to screen coordinates.
    func screenPoint(fromPanel p: CGPoint) -> NSPoint {
        NSPoint(x: frame.minX + p.x, y: frame.maxY - p.y)
    }

    /// Where you last dragged it; otherwise bottom centre of the main screen.
    private func plannedOrigin() -> NSPoint {
        guard let screen = NSScreen.main else { return frame.origin }
        let area = screen.visibleFrame
        var origin = NSPoint(x: area.midX - frame.width / 2, y: area.minY + 80)
        if let saved = UserDefaults.standard.string(forKey: Self.originKey) {
            origin = NSPointFromString(saved)
        }
        return clamped(origin, in: area)
    }

    private func placeInitially() {
        move(to: plannedOrigin())
    }

    /// Nudge the panel so no part of it is off screen (e.g. when a long reply makes it taller).
    private func keepOnScreen() {
        guard let area = (screen ?? NSScreen.main)?.visibleFrame else { return }
        let origin = clamped(frame.origin, in: area)
        if origin != frame.origin { move(to: origin) }
    }

    private func clamped(_ point: NSPoint, in area: NSRect) -> NSPoint {
        var origin = point
        let margin: CGFloat = 12
        if frame.height > area.height - 2 * margin {
            origin.y = area.maxY - margin - frame.height
        } else {
            origin.y = min(max(origin.y, area.minY + margin), area.maxY - margin - frame.height)
        }
        origin.x = min(max(origin.x, area.minX + margin), area.maxX - margin - frame.width)
        return origin
    }

    private func move(to origin: NSPoint) {
        placingProgrammatically = true
        setFrameOrigin(origin)
        placingProgrammatically = false
    }

    override func cancelOperation(_ sender: Any?) {
        NotificationCenter.default.post(name: .phoenixEscape, object: nil)
    }
}

/// A strip you can grab to move the panel (SwiftUI content otherwise swallows the drag).
struct DragHandle: NSViewRepresentable {
    final class HandleView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    }

    func makeNSView(context: Context) -> NSView { HandleView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

struct ReplyHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

extension Notification.Name {
    static let phoenixEscape = Notification.Name("phoenixEscape")
}
