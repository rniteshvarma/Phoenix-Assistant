import Foundation

/// Measurements for the Phase 1 exit test, kept on this Mac (UserDefaults):
///  - response speed: from when you stop talking to Phoenix's first spoken word (target < 2.5 s)
///  - false wake-ups: "Phoenix, rise" heard but no request followed (target < 1 per hour listening)
@MainActor
final class PhoenixStats: ObservableObject {
    static let latencyTarget: Double = 2.5
    static let falseWakeTarget: Double = 1.0

    @Published private(set) var latencies: [Double]
    @Published private(set) var wakes: Int
    @Published private(set) var falseWakes: Int
    @Published private(set) var listeningSeconds: Double

    private let defaults = UserDefaults.standard

    init() {
        latencies = defaults.array(forKey: "stats.latencies") as? [Double] ?? []
        wakes = defaults.integer(forKey: "stats.wakes")
        falseWakes = defaults.integer(forKey: "stats.falseWakes")
        listeningSeconds = defaults.double(forKey: "stats.listeningSeconds")
    }

    func recordLatency(_ seconds: Double) {
        latencies = Array((latencies + [seconds]).suffix(50))
        save()
    }

    func recordWake() { wakes += 1; save() }
    func recordFalseWake() { falseWakes += 1; save() }
    func addListening(_ seconds: Double) { listeningSeconds += seconds; save() }

    func reset() {
        latencies = []; wakes = 0; falseWakes = 0; listeningSeconds = 0
        save()
    }

    var median: Double? {
        guard !latencies.isEmpty else { return nil }
        let sorted = latencies.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    var falseWakesPerHour: Double? {
        listeningSeconds >= 600 ? Double(falseWakes) / (listeningSeconds / 3600) : nil
    }

    var latencySummary: String {
        guard let last = latencies.last, let median else { return "First word: no voice replies measured yet" }
        let pass = median < Self.latencyTarget ? "✓" : "✗"
        return String(format: "First word: last %.1f s · median %.1f s over %d replies (target < %.1f s) %@",
                      last, median, latencies.count, Self.latencyTarget, pass)
    }

    var wakeSummary: String {
        let hours = listeningSeconds / 3600
        guard let rate = falseWakesPerHour else {
            return String(format: "Wake-ups: %d heard · %d false · %.1f h listening (need 10 min to rate)", wakes, falseWakes, hours)
        }
        let pass = rate < Self.falseWakeTarget ? "✓" : "✗"
        return String(format: "Wake-ups: %d heard · %d false · %.2f false/hour over %.1f h (target < 1/h) %@",
                      wakes, falseWakes, rate, hours, pass)
    }

    private func save() {
        defaults.set(latencies, forKey: "stats.latencies")
        defaults.set(wakes, forKey: "stats.wakes")
        defaults.set(falseWakes, forKey: "stats.falseWakes")
        defaults.set(listeningSeconds, forKey: "stats.listeningSeconds")
    }
}
