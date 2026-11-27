import AppKit
import SwiftUI

/// Color themes for Phoenix (Control Center › Appearance). Every themed color in the app
/// reads `Theme.current`, so switching redraws the Summon Bar, overlays and Control Center.
struct ThemePalette: Identifiable, Equatable {
    let id: String
    let name: String
    let deep: Color     // darkest accent (the tail of the flame)
    let ember: Color    // main accent
    let flame: Color
    let gold: Color     // brightest accent
    let core: Color     // near-white hot centre
    let amber: Color    // secondary accent for labels and chips
    let nsAccent: NSColor

    static func == (a: ThemePalette, b: ThemePalette) -> Bool { a.id == b.id }
}

private func rgb(_ r: Double, _ g: Double, _ b: Double) -> Color { Color(red: r, green: g, blue: b) }

enum Theme {
    static let all: [ThemePalette] = [
        // Molten gold: copper flowing into champagne. The default.
        ThemePalette(id: "phoenix", name: "Phoenix Gold", deep: rgb(0.42, 0.07, 0.04), ember: rgb(0.93, 0.46, 0.18), flame: rgb(0.98, 0.66, 0.30),
                     gold: rgb(1.0, 0.84, 0.56), core: rgb(1.0, 0.95, 0.84), amber: rgb(0.95, 0.78, 0.52),
                     nsAccent: NSColor(red: 0.93, green: 0.46, blue: 0.18, alpha: 1)),
        ThemePalette(id: "royal", name: "Imperial", deep: rgb(0.36, 0.22, 0.04), ember: rgb(0.82, 0.62, 0.24), flame: rgb(0.92, 0.76, 0.40),
                     gold: rgb(1.0, 0.90, 0.64), core: rgb(1.0, 0.97, 0.88), amber: rgb(0.94, 0.84, 0.58),
                     nsAccent: NSColor(red: 0.82, green: 0.62, blue: 0.24, alpha: 1)),
        ThemePalette(id: "ocean", name: "Arctic", deep: rgb(0.05, 0.16, 0.36), ember: rgb(0.36, 0.62, 0.95), flame: rgb(0.55, 0.78, 1.0),
                     gold: rgb(0.82, 0.92, 1.0), core: rgb(0.96, 0.98, 1.0), amber: rgb(0.70, 0.84, 0.98),
                     nsAccent: NSColor(red: 0.36, green: 0.62, blue: 0.95, alpha: 1)),
        ThemePalette(id: "aurora", name: "Emerald", deep: rgb(0.02, 0.26, 0.20), ember: rgb(0.18, 0.72, 0.52), flame: rgb(0.42, 0.86, 0.66),
                     gold: rgb(0.80, 0.95, 0.80), core: rgb(0.95, 1.0, 0.95), amber: rgb(0.64, 0.90, 0.74),
                     nsAccent: NSColor(red: 0.18, green: 0.72, blue: 0.52, alpha: 1)),
        ThemePalette(id: "violet", name: "Amethyst", deep: rgb(0.24, 0.08, 0.44), ember: rgb(0.58, 0.40, 0.95), flame: rgb(0.72, 0.58, 1.0),
                     gold: rgb(0.90, 0.83, 1.0), core: rgb(0.98, 0.96, 1.0), amber: rgb(0.80, 0.72, 1.0),
                     nsAccent: NSColor(red: 0.58, green: 0.40, blue: 0.95, alpha: 1)),
        ThemePalette(id: "rose", name: "Rose Gold", deep: rgb(0.42, 0.12, 0.15), ember: rgb(0.86, 0.50, 0.47), flame: rgb(0.94, 0.66, 0.60),
                     gold: rgb(1.0, 0.86, 0.79), core: rgb(1.0, 0.96, 0.93), amber: rgb(0.95, 0.76, 0.70),
                     nsAccent: NSColor(red: 0.86, green: 0.50, blue: 0.47, alpha: 1)),
        ThemePalette(id: "steel", name: "Graphite", deep: rgb(0.20, 0.22, 0.26), ember: rgb(0.62, 0.66, 0.73), flame: rgb(0.76, 0.80, 0.86),
                     gold: rgb(0.91, 0.93, 0.96), core: rgb(0.99, 0.99, 1.0), amber: rgb(0.82, 0.85, 0.90),
                     nsAccent: NSColor(red: 0.62, green: 0.66, blue: 0.73, alpha: 1)),
    ]

    static let changed = Notification.Name("PhoenixThemeChanged")

    private static var cached: ThemePalette?

    static var current: ThemePalette {
        if let cached { return cached }
        let id = UserDefaults.standard.string(forKey: "theme") ?? "phoenix"
        let found = all.first { $0.id == id } ?? all[0]
        cached = found
        return found
    }

    static func set(_ id: String) {
        guard let palette = all.first(where: { $0.id == id }) else { return }
        UserDefaults.standard.set(id, forKey: "theme")
        cached = palette
        NotificationCenter.default.post(name: changed, object: nil)
    }

    /// Play the AI-core boot animation when summoned (Control Center › Appearance).
    static var bootAnimation: Bool {
        get { UserDefaults.standard.object(forKey: "bootAnimation") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "bootAnimation") }
    }
}

/// The assistant's name and wake phrase (Control Center › General). Kept on this Mac;
/// the name is also sent to the core so Claude introduces itself by it.
enum Persona {
    static let changed = Notification.Name("PhoenixPersonaChanged")

    static var name: String {
        let n = UserDefaults.standard.string(forKey: "assistant.name")?.trimmingCharacters(in: .whitespaces) ?? ""
        return n.isEmpty ? "Phoenix" : n
    }

    static var wakePhrase: String {
        let w = UserDefaults.standard.string(forKey: "wakePhrase")?.trimmingCharacters(in: .whitespaces) ?? ""
        return w.isEmpty ? "\(name), rise" : w
    }

    static func set(name: String, wakePhrase: String) {
        UserDefaults.standard.set(name.trimmingCharacters(in: .whitespaces), forKey: "assistant.name")
        UserDefaults.standard.set(wakePhrase.trimmingCharacters(in: .whitespaces), forKey: "wakePhrase")
        NotificationCenter.default.post(name: changed, object: nil)
    }

    /// Ways speech recognition tends to spell the name (only for the default, Phoenix).
    private static func nameAlternatives() -> String {
        let n = name.lowercased()
        if n == "phoenix" { return "phoenix|phenix|fenix|feenix|phoenix's" }
        return NSRegularExpression.escapedPattern(for: n)
    }

    /// Regex for the wake phrase. The default "Phoenix, rise" keeps its tolerant spellings.
    static var wakePattern: String {
        let phrase = wakePhrase.lowercased()
        if phrase == "phoenix, rise" || phrase == "phoenix rise" {
            return "\\b(phoenix|phenix|fenix|feenix|phoenix's)[,.!?…]?\\s+a?(rise|rises|rize|ryse|rice|rhys)\\b"
        }
        let words = phrase.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" }).map { NSRegularExpression.escapedPattern(for: String($0)) }
        return "\\b" + words.joined(separator: "[,.!?…]?\\s+") + "\\b"
    }

    /// "<Name>, stop" / "stop, <Name>" and friends.
    static var stopPattern: String {
        let n = nameAlternatives()
        return "\\b(\(n))[,.!?…]?\\s+(stop|quiet|enough|cancel|shut up|be quiet)\\b" + "|\\b(stop|quiet)[,.!?…]?\\s+(\(n))\\b"
    }
}
