import Carbon.HIToolbox
import EventKit
import Foundation
import LocalAuthentication

struct PhoenixError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Read-only calendar access via EventKit. Runs only when the core asks for it.
final class CalendarBridge {
    private let store = EKEventStore()

    func events(fromISO: String, toISO: String) async throws -> String {
        guard let from = Self.parse(fromISO), let to = Self.parse(toISO) else {
            throw PhoenixError("invalid date range")
        }
        let granted = try await store.requestFullAccessToEvents()
        guard granted else {
            throw PhoenixError("Calendar access is off. Allow Phoenix in System Settings › Privacy & Security › Calendars.")
        }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(200)
        if events.isEmpty { return "No events in this period." }

        let day = DateFormatter()
        day.dateFormat = "EEE d MMM"
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        return events.map { e in
            var line = e.isAllDay
                ? "\(day.string(from: e.startDate)) · all day"
                : "\(day.string(from: e.startDate)) \(time.string(from: e.startDate))–\(time.string(from: e.endDate))"
            line += " · \(e.title ?? "(no title)")"
            if let location = e.location, !location.isEmpty { line += " · @\(location)" }
            line += " · [\(e.calendar.title)]"
            return line
        }.joined(separator: "\n")
    }

    private static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }
}

/// Touch ID (or the Mac password) before any approval is sent.
enum Auth {
    static func confirm(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

/// Global ⌥Space hotkey (falls back to ⌃⌥Space if another app already owns ⌥Space).
final class HotKey {
    private static var action: (() -> Void)?
    private var ref: EventHotKeyRef?
    private(set) var label = ""

    init(action: @escaping () -> Void) {
        HotKey.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            HotKey.action?()
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x5048_4E58), id: 1) // "PHNX"
        if RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref) == noErr {
            label = "⌥Space"
        } else if RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey | controlKey), id, GetApplicationEventTarget(), 0, &ref) == noErr {
            label = "⌃⌥Space"
        } else {
            label = "unavailable"
        }
    }
}
