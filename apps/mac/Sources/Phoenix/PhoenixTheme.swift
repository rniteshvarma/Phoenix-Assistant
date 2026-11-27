import SwiftUI

// MARK: - Fire palette

/// The accent palette; follows the theme chosen in Control Center › Appearance.
enum Fire {
    static var crimson: Color { Theme.current.deep }
    static var ember: Color { Theme.current.ember }
    static var flame: Color { Theme.current.flame }
    static var gold: Color { Theme.current.gold }
    static var core: Color { Theme.current.core }

    /// Bottom-to-top: deep at the tail, brightest at the head.
    static var body: LinearGradient { LinearGradient(colors: [crimson, ember, flame, gold], startPoint: .bottom, endPoint: .top) }
    static var wing: LinearGradient { LinearGradient(colors: [crimson, ember, gold], startPoint: .bottomTrailing, endPoint: .topLeading) }
    static var ring: [Color] { [crimson, ember, gold, core, gold, ember, crimson] }
}

/// Smooth 0→1 easing for the rise.
func easeOutBack(_ x: Double) -> Double {
    let c1 = 1.70158, c3 = c1 + 1
    return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2)
}

func clamp01(_ x: Double) -> Double { min(1, max(0, x)) }

// MARK: - AI core

/// Phoenix's abstract "core": a glowing point of fire inside a turning HUD ring.
/// Scales in when Phoenix is summoned and pulses while it's active.
struct CoreOrb: View {
    let size: CGFloat
    let active: Bool
    var riseStartedAt: Date = .distantPast

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let elapsed = context.date.timeIntervalSince(riseStartedAt)
            let rise = elapsed < 0 ? 1 : easeOutBack(clamp01(elapsed / 0.7))
            let pulse = active ? 0.85 + 0.15 * sin(t * 3.4) : 0.7
            ZStack {
                HUDRing(t: t, active: active)
                Circle()
                    .fill(RadialGradient(colors: [Fire.core, Fire.gold.opacity(0.9), Fire.ember.opacity(0.45), .clear],
                                         center: .center, startRadius: 0, endRadius: size * 0.28))
                    .frame(width: size * 0.56, height: size * 0.56)
                    .scaleEffect(pulse)
                Circle()
                    .stroke(AngularGradient(colors: Fire.ring, center: .center, angle: .degrees(t * 90)), lineWidth: 1.2)
                    .frame(width: size * 0.36, height: size * 0.36)
            }
            .frame(width: size, height: size)
            .scaleEffect(0.6 + 0.4 * rise)
            .opacity(clamp01(elapsed < 0 ? 1 : elapsed / 0.3))
        }
    }
}

// MARK: - Rising embers

/// Sparks drifting up through the panel. Deterministic (no stored state), driven by time.
struct EmberField: View {
    let intensity: Double
    var riseStartedAt: Date = .distantPast
    var count = 46

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let sinceRise = context.date.timeIntervalSince(riseStartedAt)
            let burst = sinceRise >= 0 && sinceRise < 1.6 ? (1 - sinceRise / 1.6) : 0
            let level = min(1.0, intensity + burst * 0.9)
            Canvas { ctx, size in
                guard level > 0.01 else { return }
                for i in 0..<count {
                    let s = Double(i) + 1
                    let rx = fract(sin(s * 12.9898) * 43758.5453)
                    let rs = fract(sin(s * 78.233) * 12345.678)
                    let rp = fract(sin(s * 39.425) * 9876.543)
                    let speed = 0.06 + rs * 0.16 + burst * 0.25
                    let progress = fract(t * speed + rp)
                    let x = rx * size.width + sin(t * 1.3 + s) * 10
                    let y = size.height * (1 - progress)
                    let r = 0.8 + rs * 2.0
                    let fade = sin(progress * .pi) * level
                    let color = progress < 0.35 ? Fire.gold : (progress < 0.7 ? Fire.flame : Fire.ember)
                    ctx.fill(Path(ellipseIn: CGRect(x: x - r * 2.5, y: y - r * 2.5, width: r * 5, height: r * 5)),
                             with: .color(color.opacity(fade * 0.12)))
                    ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)),
                             with: .color(color.opacity(fade * 0.85)))
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func fract(_ x: Double) -> Double { x - floor(x) }
}

// MARK: - Fire border

/// A slowly turning ring of fire around the panel while Phoenix is active.
struct FireBorder: View {
    let active: Bool
    let cornerRadius: CGFloat

    var body: some View {
        TimelineView(.animation) { context in
            let angle = context.date.timeIntervalSinceReferenceDate * 50
            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius).stroke(Ember.border, lineWidth: 1)
                if active {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .stroke(AngularGradient(colors: Fire.ring, center: .center, angle: .degrees(angle)), lineWidth: 1.6)
                        .blur(radius: 0.4)
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .stroke(AngularGradient(colors: Fire.ring, center: .center, angle: .degrees(angle)), lineWidth: 6)
                        .blur(radius: 10)
                        .opacity(0.35)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - HUD ring

/// A thin heads-up-display ring: tick marks, a faint track and arc segments turning at
/// different speeds, in the fire gradient. Sits behind the large phoenix.
struct HUDRing: View {
    let t: Double
    let active: Bool

    var body: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 - 1
            let fire = GraphicsContext.Shading.conicGradient(Gradient(colors: Fire.ring), center: c, angle: .degrees(t * 30))
            // Track
            ctx.stroke(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                       with: .color(Fire.ember.opacity(0.18)), lineWidth: 0.6)
            // Ticks
            for i in 0..<72 {
                let a = Double(i) / 72 * 2 * .pi + t * 0.15
                let long = i % 6 == 0
                let r1 = r - (long ? 5 : 2.5)
                var tick = Path()
                tick.move(to: CGPoint(x: c.x + cos(a) * r1, y: c.y + sin(a) * r1))
                tick.addLine(to: CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r))
                ctx.stroke(tick, with: .color(Fire.gold.opacity(long ? 0.45 : 0.18)), lineWidth: long ? 0.8 : 0.5)
            }
            // Rotating arcs
            let speed = active ? 1.0 : 0.35
            for (radius, start, sweep, rate, width) in [(r + 0.5, 0.0, 70.0, 40.0, 1.6), (r + 0.5, 180.0, 40.0, 40.0, 1.6),
                                                        (r - 8, 90.0, 110.0, -24.0, 1.0), (r - 8, 300.0, 25.0, -24.0, 1.0)] {
                var arc = Path()
                let a0 = start + t * rate * speed
                arc.addArc(center: c, radius: radius, startAngle: .degrees(a0), endAngle: .degrees(a0 + sweep), clockwise: false)
                ctx.stroke(arc, with: fire, style: StrokeStyle(lineWidth: width, lineCap: .round))
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Tech panel chrome

/// Hairline border with two short "comets" of fire light travelling around it while active.
struct TechBorder: View {
    let active: Bool
    let cornerRadius: CGFloat

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let p = (t * 0.18).truncatingRemainder(dividingBy: 1)
            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(LinearGradient(colors: [Color.white.opacity(0.14), Color.white.opacity(0.05)],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
                if active {
                    comet(at: p)
                    comet(at: (p + 0.5).truncatingRemainder(dividingBy: 1))
                }
            }
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private func comet(at start: Double) -> some View {
        let length = 0.08
        let end = start + length
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        let style = StrokeStyle(lineWidth: 1.6, lineCap: .round)
        let fire = LinearGradient(colors: [Fire.crimson, Fire.ember, Fire.gold, Fire.core], startPoint: .leading, endPoint: .trailing)
        ZStack {
            shape.trim(from: start, to: min(end, 1)).stroke(fire, style: style)
            if end > 1 { shape.trim(from: 0, to: end - 1).stroke(fire, style: style) }
        }
        .shadow(color: Fire.gold.opacity(0.9), radius: 3)
    }
}

/// A faint dot grid, fading toward the bottom: the "tech" texture behind the panel content.
struct DotGrid: View {
    var spacing: CGFloat = 16

    var body: some View {
        Canvas { ctx, size in
            var y: CGFloat = spacing / 2
            while y < size.height {
                let fade = 1 - Double(y / size.height) * 0.7
                var x: CGFloat = spacing / 2
                while x < size.width {
                    ctx.fill(Path(ellipseIn: CGRect(x: x - 0.6, y: y - 0.6, width: 1.2, height: 1.2)),
                             with: .color(Color.white.opacity(0.07 * fade)))
                    x += spacing
                }
                y += spacing
            }
        }
        .allowsHitTesting(false)
    }
}

/// Pill showing what Phoenix is doing, with a softly pulsing status light.
struct StatusChip: View {
    let phase: Phase
    let speaking: Bool

    var body: some View {
        let (label, color) = describe()
        TimelineView(.animation) { context in
            let pulse = 0.55 + 0.45 * (sin(context.date.timeIntervalSinceReferenceDate * 4) + 1) / 2
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 6, height: 6)
                    .shadow(color: color, radius: 3)
                    .opacity(isLive ? pulse : 1)
                Text(label)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(1.3)
                    .foregroundStyle(color)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.10)))
            .overlay(Capsule().stroke(color.opacity(0.35), lineWidth: 0.8))
        }
    }

    private var isLive: Bool { speaking || [.listening, .thinking, .working, .waitingForYou].contains(phase) }

    private func describe() -> (String, Color) {
        if speaking { return ("SPEAKING", Fire.ember) }
        switch phase {
        case .listening: return ("LISTENING", Fire.gold)
        case .thinking: return ("THINKING", Fire.flame)
        case .working: return ("WORKING", Fire.ember)
        case .waitingForYou: return ("NEEDS YOUR OK", Ember.warn)
        case .done: return ("DONE", Ember.green)
        case .failed: return ("STOPPED", Ember.red)
        case .offline: return ("OFFLINE", Ember.dim)
        case .idle: return ("READY", Ember.dim)
        }
    }
}
