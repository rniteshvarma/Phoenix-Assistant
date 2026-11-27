import AppKit
import SwiftUI

/// The summoning effect: an "AI core boot-up" played where the voice box opens.
/// Data particles spiral in and converge, HUD rings draw on around a glowing core,
/// corner brackets and a scan beam frame the panel, then it opens.
/// Plays in a transparent, click-through window above everything, for about one second.
@MainActor
final class SummonOverlay {
    static let arrival: TimeInterval = 0.85
    static let total: TimeInterval = 1.25

    private var window: NSWindow?
    private var token = UUID()

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || !Theme.bootAnimation }

    /// Play around `core` (where the panel's phoenix will appear) framing `panel`, both in
    /// screen coordinates, and call `onArrive` as the panel should open.
    func play(core: NSPoint, panel: NSRect, on screen: NSScreen, onArrive: @escaping () -> Void) {
        window?.orderOut(nil)
        let frame = screen.frame
        let win = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.setFrame(frame, display: false)
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.ignoresMouseEvents = true
        win.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        win.isReleasedWhenClosed = false

        // SwiftUI coordinates: origin top-left, y grows downward.
        let toLocal = { (p: NSPoint) in CGPoint(x: p.x - frame.minX, y: frame.maxY - p.y) }
        let localPanel = CGRect(x: panel.minX - frame.minX, y: frame.maxY - panel.maxY, width: panel.width, height: panel.height)
        let view = BootUpView(start: Date(), core: toLocal(core), panel: localPanel)
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: frame.size)
        win.contentView = host
        win.orderFrontRegardless()
        window = win

        let run = UUID()
        token = run
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.arrival) { onArrive() }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.total) { [weak self] in
            guard let self, self.token == run else { return }
            self.window?.orderOut(nil)
            self.window = nil
        }
    }
}

/// One frame of the boot-up, computed purely from elapsed time.
struct BootUpView: View {
    let start: Date
    let core: CGPoint
    let panel: CGRect

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSince(start)
            let after = max(0, t - SummonOverlay.arrival)        // time since the panel opened
            let fadeOut = 1 - clamp01(after / 0.38)

            ZStack {
                Canvas { ctx, _ in
                    ctx.blendMode = .plusLighter
                    drawParticles(&ctx, t: t)
                    drawRings(&ctx, t: t, after: after, fade: fadeOut)
                    drawCore(&ctx, t: t, after: after)
                    drawBrackets(&ctx, t: t, fade: fadeOut)
                    drawScan(&ctx, t: t)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .allowsHitTesting(false)
    }

    // 1. Data stream: particles spiral in from all around and converge on the core.
    private func drawParticles(_ ctx: inout GraphicsContext, t: Double) {
        for i in 0..<84 {
            let seed = Double(i) + 1
            let r0 = rand(seed * 1.7)
            let delay = rand(seed * 3.1) * 0.2
            let p = clamp01((t - delay) / 0.42)
            guard p > 0 && p < 1 else { continue }
            let eased = p * p * p
            let startRadius = 150 + r0 * 230
            let angle = seed * 2.39996 + eased * 1.6
            let radius = startRadius * (1 - eased)
            let pos = CGPoint(x: core.x + cos(angle) * radius, y: core.y + sin(angle) * radius)
            let back = startRadius * (1 - max(0, eased - 0.08))
            let tail = CGPoint(x: core.x + cos(angle - 0.12) * back, y: core.y + sin(angle - 0.12) * back)
            let alpha = min(1, p * 3.5) * (1 - pow(p, 6))   // visible at once, fades as it lands
            let color = r0 < 0.33 ? Fire.gold : (r0 < 0.66 ? Fire.flame : Fire.ember)

            var line = Path()
            line.move(to: tail)
            line.addLine(to: pos)
            ctx.stroke(line, with: .color(color.opacity(alpha * 0.6)), lineWidth: 0.9)
            let s = 2.0 + rand(seed * 5.3) * 2.0
            ctx.fill(Path(CGRect(x: pos.x - s / 2, y: pos.y - s / 2, width: s, height: s)), with: .color(color.opacity(alpha)))
        }
    }

    // 2. HUD rings drawing on around the core, then expanding out as the panel opens.
    private func drawRings(_ ctx: inout GraphicsContext, t: Double, after: Double, fade: Double) {
        guard fade > 0 else { return }
        let grow = 1 + after * 2.2
        let rings: [(radius: Double, delay: Double, width: Double, dash: [CGFloat], speed: Double)] = [
            (38, 0.12, 1.4, [], 70), (56, 0.18, 1.0, [10, 6], -110), (76, 0.24, 0.8, [2, 5], 50), (98, 0.30, 1.2, [36, 14], -40),
        ]
        let shading = GraphicsContext.Shading.conicGradient(Gradient(colors: Fire.ring), center: core, angle: .degrees(t * 120))
        for ring in rings {
            let q = easeOutCubic(clamp01((t - ring.delay) / 0.32))
            guard q > 0 else { continue }
            let r = ring.radius * grow
            let rotation = t * ring.speed
            var arc = Path()
            arc.addArc(center: core, radius: r, startAngle: .degrees(rotation), endAngle: .degrees(rotation + 360 * q), clockwise: false)
            ctx.stroke(arc, with: shading, style: StrokeStyle(lineWidth: ring.width, lineCap: .round, dash: ring.dash))
        }
        // Tick ring
        let q = clamp01((t - 0.2) / 0.35)
        let r = 112 * grow
        for i in 0..<60 where Double(i) / 60 < q {
            let a = Double(i) / 60 * 2 * .pi - .pi / 2
            let long = i % 5 == 0
            var tick = Path()
            tick.move(to: CGPoint(x: core.x + cos(a) * (r - (long ? 6 : 3)), y: core.y + sin(a) * (r - (long ? 6 : 3))))
            tick.addLine(to: CGPoint(x: core.x + cos(a) * r, y: core.y + sin(a) * r))
            ctx.stroke(tick, with: .color(Fire.gold.opacity((long ? 0.7 : 0.35) * fade)), lineWidth: long ? 1 : 0.6)
        }
    }

    // 3. The core: a glowing point that charges up, then flashes as the panel opens.
    private func drawCore(_ ctx: inout GraphicsContext, t: Double, after: Double) {
        let charge = clamp01(t / SummonOverlay.arrival)
        let flash = after > 0 ? (1 - clamp01(after / 0.3)) : 0
        let radius = 10 + 26 * charge * charge + 90 * flash
        let alpha = 0.35 + 0.5 * charge * charge + 0.4 * flash
        ctx.fill(Path(ellipseIn: CGRect(x: core.x - radius, y: core.y - radius, width: radius * 2, height: radius * 2)),
                 with: .radialGradient(Gradient(colors: [Fire.core.opacity(min(1, alpha)), Fire.ember.opacity(alpha * 0.4), .clear]),
                                       center: core, startRadius: 0, endRadius: radius))
    }

    // 4. Corner brackets marking where the panel will appear.
    private func drawBrackets(_ ctx: inout GraphicsContext, t: Double, fade: Double) {
        let q = easeOutCubic(clamp01((t - 0.38) / 0.3))
        guard q > 0, fade > 0 else { return }
        let inset = 10 * (1 - q)
        let box = panel.insetBy(dx: -inset - 4, dy: -inset - 4)
        let arm = 22.0 * q
        var path = Path()
        for (corner, dx, dy) in [(CGPoint(x: box.minX, y: box.minY), 1.0, 1.0), (CGPoint(x: box.maxX, y: box.minY), -1.0, 1.0),
                                 (CGPoint(x: box.minX, y: box.maxY), 1.0, -1.0), (CGPoint(x: box.maxX, y: box.maxY), -1.0, -1.0)] {
            path.move(to: CGPoint(x: corner.x + dx * arm, y: corner.y))
            path.addLine(to: corner)
            path.addLine(to: CGPoint(x: corner.x, y: corner.y + dy * arm))
        }
        ctx.stroke(path, with: .color(Fire.gold.opacity(q * fade)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
    }

    // 5. A scan beam sweeping across the panel area just before it opens.
    private func drawScan(_ ctx: inout GraphicsContext, t: Double) {
        let s = clamp01((t - 0.52) / 0.36)
        guard s > 0 && s < 1 else { return }
        let x = panel.minX + panel.width * easeInOutCubic(s)
        let beam = CGRect(x: x - 1, y: panel.minY, width: 2, height: panel.height)
        let glow = CGRect(x: x - 28, y: panel.minY, width: 28, height: panel.height)
        ctx.fill(Path(glow), with: .linearGradient(Gradient(colors: [.clear, Fire.ember.opacity(0.22)]),
                                                   startPoint: CGPoint(x: glow.minX, y: 0), endPoint: CGPoint(x: glow.maxX, y: 0)))
        ctx.fill(Path(beam), with: .linearGradient(Gradient(colors: [.clear, Fire.gold, Fire.core, Fire.gold, .clear]),
                                                   startPoint: CGPoint(x: 0, y: beam.minY), endPoint: CGPoint(x: 0, y: beam.maxY)))
    }

    private func rand(_ x: Double) -> Double { let v = sin(x * 12.9898) * 43758.5453; return v - floor(v) }
}

func easeInOutCubic(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
func easeOutCubic(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
