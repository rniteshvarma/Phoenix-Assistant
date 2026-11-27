// Draws the Phoenix logo (app icon and in-app mark) with Core Graphics, so it can be
// regenerated exactly. Usage: swift tools/PhoenixIcon.swift <out-dir> [concept]
import AppKit
import CoreGraphics

let S: CGFloat = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
func c(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(colorSpace: cs, components: [r, g, b, a])! }

// Molten palette: garnet → ember → amber → champagne → white-hot.
let garnet = c(0.45, 0.07, 0.05), ember = c(0.92, 0.33, 0.14), amber = c(0.97, 0.62, 0.24)
let champagne = c(0.98, 0.86, 0.62), hot = c(1.0, 0.98, 0.92)

func gradient(_ colors: [CGColor], _ locs: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: cs, colors: colors as CFArray, locations: locs)!
}

func context(_ size: Int) -> CGContext {
    CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func save(_ ctx: CGContext, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

/// macOS icon body: 824pt squircle with an obsidian, slightly warm glass look.
func drawBase(_ g: CGContext) {
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)
    // Soft drop shadow
    g.saveGState()
    g.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: c(0, 0, 0, 0.55))
    g.addPath(shape); g.setFillColor(c(0.03, 0.03, 0.04)); g.fillPath()
    g.restoreGState()
    g.saveGState()
    g.addPath(shape); g.clip()
    g.drawLinearGradient(gradient([c(0.085, 0.075, 0.075), c(0.025, 0.025, 0.035)], [0, 1]),
                         start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    // Ember glow rising from below the mark
    g.drawRadialGradient(gradient([c(0.95, 0.45, 0.16, 0.30), c(0.55, 0.12, 0.05, 0.16), c(0, 0, 0, 0)], [0, 0.5, 1]),
                         startCenter: CGPoint(x: 512, y: 470), startRadius: 0, endCenter: CGPoint(x: 512, y: 470), endRadius: 470, options: [])
    // Corner vignette for depth
    g.drawRadialGradient(gradient([c(0, 0, 0, 0), c(0, 0, 0, 0.45)], [0.55, 1]),
                         startCenter: CGPoint(x: 512, y: 512), startRadius: 0, endCenter: CGPoint(x: 512, y: 512), endRadius: 600, options: [])
    // Fine tech grid
    g.setStrokeColor(c(1, 1, 1, 0.035)); g.setLineWidth(1.5)
    var x: CGFloat = 100
    while x < 924 { g.move(to: CGPoint(x: x, y: 100)); g.addLine(to: CGPoint(x: x, y: 924)); x += 41.2 }
    var y: CGFloat = 100
    while y < 924 { g.move(to: CGPoint(x: 100, y: y)); g.addLine(to: CGPoint(x: 924, y: y)); y += 41.2 }
    g.strokePath()
    // Top glass sheen
    g.drawLinearGradient(gradient([c(1, 1, 1, 0.07), c(1, 1, 1, 0)], [0, 1]),
                         start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 640), options: [])
    g.restoreGState()
    // Hairline rim: champagne at the top, fading down
    g.saveGState()
    g.addPath(CGPath(roundedRect: body.insetBy(dx: 2, dy: 2), cornerWidth: 184, cornerHeight: 184, transform: nil))
    g.setLineWidth(4); g.replacePathWithStrokedPath(); g.clip()
    g.drawLinearGradient(gradient([c(0.98, 0.86, 0.62, 0.55), c(0.98, 0.86, 0.62, 0.06)], [0, 1]),
                         start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    g.restoreGState()
}

/// Fill the current path with a vertical molten gradient between y0 (bottom) and y1 (top).
func fillMolten(_ g: CGContext, _ path: CGPath, _ y0: CGFloat, _ y1: CGFloat, glow: CGFloat = 26) {
    g.saveGState()
    g.setShadow(offset: .zero, blur: glow, color: c(0.92, 0.33, 0.14, 0.75))
    g.addPath(path); g.setFillColor(ember); g.fillPath()
    g.restoreGState()
    g.saveGState()
    g.addPath(path); g.clip()
    g.drawLinearGradient(gradient([garnet, ember, amber, champagne, hot], [0, 0.3, 0.6, 0.85, 1]),
                         start: CGPoint(x: 512, y: y0), end: CGPoint(x: 512, y: y1), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    g.restoreGState()
}

func strokeMolten(_ g: CGContext, _ path: CGPath, width: CGFloat, y0: CGFloat, y1: CGFloat, alpha: CGFloat = 1) {
    g.saveGState()
    g.addPath(path); g.setLineWidth(width); g.setLineCap(.round); g.replacePathWithStrokedPath(); g.clip()
    g.setAlpha(alpha)
    g.drawLinearGradient(gradient([garnet, ember, amber, champagne], [0, 0.35, 0.7, 1]),
                         start: CGPoint(x: 512, y: y0), end: CGPoint(x: 512, y: y1), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    g.restoreGState()
}

/// Flame/teardrop pointing up, centred on x = 512.
func flame(tip: CGFloat, bottom: CGFloat, width: CGFloat) -> CGPath {
    let p = CGMutablePath()
    let h = tip - bottom
    p.move(to: CGPoint(x: 512, y: tip))
    p.addCurve(to: CGPoint(x: 512 + width / 2, y: bottom + h * 0.32),
               control1: CGPoint(x: 512 + width * 0.08, y: tip - h * 0.28), control2: CGPoint(x: 512 + width / 2, y: bottom + h * 0.62))
    p.addCurve(to: CGPoint(x: 512, y: bottom),
               control1: CGPoint(x: 512 + width / 2, y: bottom + h * 0.1), control2: CGPoint(x: 512 + width * 0.24, y: bottom))
    p.addCurve(to: CGPoint(x: 512 - width / 2, y: bottom + h * 0.32),
               control1: CGPoint(x: 512 - width * 0.24, y: bottom), control2: CGPoint(x: 512 - width / 2, y: bottom + h * 0.1))
    p.addCurve(to: CGPoint(x: 512, y: tip),
               control1: CGPoint(x: 512 - width / 2, y: bottom + h * 0.62), control2: CGPoint(x: 512 - width * 0.08, y: tip - h * 0.28))
    p.closeSubpath()
    return p
}

/// A swept wing blade, from near the centre bottom out and up to a tip (mirrored with side = -1).
func wing(side: CGFloat, root: CGPoint, tip: CGPoint, thickness: CGFloat) -> CGPath {
    let p = CGMutablePath()
    let r = CGPoint(x: 512 + side * (root.x - 512), y: root.y)
    let t = CGPoint(x: 512 + side * (tip.x - 512), y: tip.y)
    p.move(to: r)
    p.addCurve(to: t, control1: CGPoint(x: r.x + side * 150, y: r.y + 10), control2: CGPoint(x: t.x + side * 10, y: t.y - 170))
    p.addCurve(to: CGPoint(x: r.x + side * thickness * 0.3, y: r.y + thickness),
               control1: CGPoint(x: t.x - side * 40, y: t.y - 150), control2: CGPoint(x: r.x + side * 110, y: r.y + thickness + 10))
    p.closeSubpath()
    return p
}

func arc(_ center: CGPoint, _ r: CGFloat, _ a0: CGFloat, _ a1: CGFloat) -> CGPath {
    let p = CGMutablePath()
    p.addArc(center: center, radius: r, startAngle: a0 * .pi / 180, endAngle: a1 * .pi / 180, clockwise: false)
    return p
}

/// A: "Ascend" — a molten flame core rising out of two swept wing blades, inside a segmented HUD ring.
func conceptA(_ g: CGContext) {
    let o = CGPoint(x: 512, y: 500)
    for (a0, a1) in [(30.0, 150.0), (170.0, 235.0), (305.0, 370.0)] {
        strokeMolten(g, arc(o, 292, a0, a1), width: 9, y0: 200, y1: 800, alpha: 0.9)
    }
    strokeMolten(g, arc(o, 262, 0, 360), width: 2.5, y0: 200, y1: 800, alpha: 0.35)
    for k in 0..<36 { // tick marks
        let a = CGFloat(k) * 10 * .pi / 180
        let p = CGMutablePath()
        p.move(to: CGPoint(x: o.x + cos(a) * 312, y: o.y + sin(a) * 312))
        p.addLine(to: CGPoint(x: o.x + cos(a) * (k % 3 == 0 ? 330 : 322), y: o.y + sin(a) * (k % 3 == 0 ? 330 : 322)))
        strokeMolten(g, p, width: 3, y0: 150, y1: 850, alpha: 0.45)
    }
    for s in [-1.0, 1.0] as [CGFloat] {
        fillMolten(g, wing(side: s, root: CGPoint(x: 532, y: 300), tip: CGPoint(x: 735, y: 650), thickness: 46), 300, 700, glow: 18)
    }
    fillMolten(g, flame(tip: 760, bottom: 330, width: 170), 330, 760)
    fillMolten(g, flame(tip: 610, bottom: 380, width: 70), 380, 610, glow: 10)
    g.saveGState()
    g.addPath(flame(tip: 560, bottom: 398, width: 34)); g.setFillColor(hot); g.fillPath()
    g.restoreGState()
}

/// B: "Crest" — three rising chevrons (wings / flames) under a diamond core.
func conceptB(_ g: CGContext) {
    func chevron(y: CGFloat, half: CGFloat, rise: CGFloat, thick: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 512 - half, y: y + rise))
        p.addLine(to: CGPoint(x: 512, y: y))
        p.addLine(to: CGPoint(x: 512 + half, y: y + rise))
        p.addLine(to: CGPoint(x: 512 + half, y: y + rise + thick))
        p.addLine(to: CGPoint(x: 512, y: y + thick))
        p.addLine(to: CGPoint(x: 512 - half, y: y + rise + thick))
        p.closeSubpath()
        return p
    }
    fillMolten(g, chevron(y: 250, half: 300, rise: 300, thick: 56), 250, 610, glow: 16)
    fillMolten(g, chevron(y: 360, half: 225, rise: 225, thick: 52), 360, 640, glow: 16)
    fillMolten(g, chevron(y: 470, half: 150, rise: 150, thick: 48), 470, 670, glow: 16)
    let d = CGMutablePath()
    d.move(to: CGPoint(x: 512, y: 790)); d.addLine(to: CGPoint(x: 572, y: 700)); d.addLine(to: CGPoint(x: 512, y: 610)); d.addLine(to: CGPoint(x: 452, y: 700)); d.closeSubpath()
    fillMolten(g, d, 610, 790, glow: 30)
}

/// Metallic molten fill: deep garnet → copper → gold → champagne, with a bright specular band.
func fillMetal(_ g: CGContext, _ path: CGPath, _ y0: CGFloat, _ y1: CGFloat, glow: CGFloat = 22) {
    g.saveGState()
    g.setShadow(offset: .zero, blur: glow, color: c(0.95, 0.45, 0.15, 0.55))
    g.addPath(path); g.setFillColor(c(0.8, 0.35, 0.12)); g.fillPath()
    g.restoreGState()
    g.saveGState()
    g.addPath(path); g.clip()
    g.drawLinearGradient(gradient([c(0.42, 0.07, 0.04), c(0.80, 0.26, 0.09), c(0.96, 0.55, 0.20), c(1.0, 0.78, 0.42),
                                   c(1.0, 0.94, 0.80), c(0.99, 0.82, 0.52)], [0, 0.14, 0.34, 0.58, 0.8, 1]),
                         start: CGPoint(x: 512, y: y0), end: CGPoint(x: 512, y: y1), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    // Diagonal sheen
    g.setBlendMode(.screen)
    g.drawLinearGradient(gradient([c(1, 1, 1, 0), c(1, 0.95, 0.85, 0.28), c(1, 1, 1, 0)], [0.35, 0.5, 0.65]),
                         start: CGPoint(x: 250, y: y0), end: CGPoint(x: 780, y: y1), options: [])
    g.restoreGState()
}

/// D: "Crest" refined — curved, wing-like chevrons rising to a faceted diamond core.
func conceptD(_ g: CGContext) {
    // A chevron whose arms curve upward like wings; thickness tapers toward the tips.
    func wingChevron(y: CGFloat, half: CGFloat, rise: CGFloat, thick: CGFloat) -> CGPath {
        let p = CGMutablePath()
        let tipL = CGPoint(x: 512 - half, y: y + rise), tipR = CGPoint(x: 512 + half, y: y + rise)
        p.move(to: CGPoint(x: 512, y: y))
        p.addCurve(to: tipR, control1: CGPoint(x: 512 + half * 0.45, y: y + rise * 0.18), control2: CGPoint(x: 512 + half * 0.85, y: y + rise * 0.55))
        p.addLine(to: CGPoint(x: tipR.x - thick * 0.35, y: tipR.y + thick * 0.15))
        p.addCurve(to: CGPoint(x: 512, y: y + thick),
                   control1: CGPoint(x: 512 + half * 0.78, y: y + rise * 0.62 + thick), control2: CGPoint(x: 512 + half * 0.4, y: y + rise * 0.22 + thick))
        p.addCurve(to: CGPoint(x: tipL.x + thick * 0.35, y: tipL.y + thick * 0.15),
                   control1: CGPoint(x: 512 - half * 0.4, y: y + rise * 0.22 + thick), control2: CGPoint(x: 512 - half * 0.78, y: y + rise * 0.62 + thick))
        p.addLine(to: tipL)
        p.addCurve(to: CGPoint(x: 512, y: y), control1: CGPoint(x: 512 - half * 0.85, y: y + rise * 0.55), control2: CGPoint(x: 512 - half * 0.45, y: y + rise * 0.18))
        p.closeSubpath()
        return p
    }
    fillMetal(g, wingChevron(y: 238, half: 318, rise: 372, thick: 54), 238, 640, glow: 14)
    fillMetal(g, wingChevron(y: 340, half: 238, rise: 282, thick: 52), 340, 650, glow: 14)
    fillMetal(g, wingChevron(y: 442, half: 158, rise: 192, thick: 50), 442, 660, glow: 14)
    // Faceted diamond core: four facets with different light.
    let top = CGPoint(x: 512, y: 812), right = CGPoint(x: 578, y: 716), bottom = CGPoint(x: 512, y: 620), left = CGPoint(x: 446, y: 716), mid = CGPoint(x: 512, y: 716)
    let outline = CGMutablePath(); outline.addLines(between: [top, right, bottom, left]); outline.closeSubpath()
    fillMetal(g, outline, 620, 812, glow: 40)
    let facets: [([CGPoint], CGColor)] = [([top, right, mid], c(1, 1, 1, 0.30)), ([top, left, mid], c(1, 1, 1, 0.12)),
                                          ([bottom, right, mid], c(0.3, 0.02, 0, 0.18)), ([bottom, left, mid], c(0.3, 0.02, 0, 0.32))]
    for (pts, col) in facets {
        let f = CGMutablePath(); f.addLines(between: pts); f.closeSubpath()
        g.addPath(f); g.setFillColor(col); g.fillPath()
    }
}

/// C: "Core" — the Summon Bar's AI core: rings and ticks around a rising flame.
func conceptC(_ g: CGContext) {
    let o = CGPoint(x: 512, y: 512)
    strokeMolten(g, arc(o, 300, 0, 360), width: 5, y0: 200, y1: 820, alpha: 0.85)
    strokeMolten(g, arc(o, 240, 100, 440), width: 14, y0: 200, y1: 820, alpha: 0.95)
    strokeMolten(g, arc(o, 196, 0, 360), width: 2, y0: 200, y1: 820, alpha: 0.4)
    fillMolten(g, flame(tip: 700, bottom: 340, width: 210), 340, 700)
    fillMolten(g, flame(tip: 600, bottom: 380, width: 96), 380, 600, glow: 10)
    g.saveGState(); g.addPath(flame(tip: 548, bottom: 400, width: 46)); g.setFillColor(hot); g.fillPath(); g.restoreGState()
}

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "."
let only = args.count > 2 ? args[2] : nil  // The chosen logo is "D"; app icon: Resources/AppIcon.icns
let concepts: [(String, (CGContext) -> Void)] = [("A", conceptA), ("B", conceptB), ("C", conceptC), ("D", conceptD)]
for (name, draw) in concepts where only == nil || only == name {
    let icon = context(Int(S)); drawBase(icon); draw(icon); save(icon, "\(out)/icon-\(name).png")
    let mark = context(Int(S)); draw(mark); save(mark, "\(out)/mark-\(name).png")
}
print("ok")
