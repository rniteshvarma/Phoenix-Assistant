import AppKit
import Contacts
import EventKit
import Foundation

/// Phase 4a: actions Phoenix performs on this Mac through each app's official interfaces.
/// Permissions (Reminders, Contacts, Automation for Messages/Notes) are asked the first time.
@MainActor
final class MacActions {
    private let store = EKEventStore()
    private let contacts = CNContactStore()
    let screen = ScreenControl()

    /// Run one tool the core asked for; returns the text result.
    func run(_ tool: String, _ input: [String: Any]) async throws -> String {
        func str(_ key: String) -> String? { (input[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        switch tool {
        case "reminders_list": return try await remindersList(list: str("list"))
        case "reminders_add": return try await remindersAdd(title: str("title") ?? "", due: str("due"), list: str("list"), notes: str("notes"))
        case "reminders_complete": return try await remindersComplete(id: str("id") ?? "")
        case "reminders_due_json": return try await remindersDueJSON(minutes: input["minutes"] as? Int ?? 1)
        case "calendar_add_event":
            return try await calendarAdd(title: str("title") ?? "", start: str("start") ?? "", end: str("end") ?? "",
                                         location: str("location"), notes: str("notes"))
        case "calendar_upcoming_json": return try await calendarUpcomingJSON(minutes: input["minutes"] as? Int ?? 15)
        case "contacts_search": return try await contactsSearch(str("name") ?? "")
        case "messages_send": return try messagesSend(to: str("to") ?? "", text: str("text") ?? "")
        case "apple_notes_create": return try notesCreate(title: str("title") ?? "", body: str("body") ?? "")
        case "app_open": return try appOpen(str("target") ?? "")
        case let t where t.hasPrefix("screen_"): return try await screen.run(t, input)
        default: throw PhoenixError("this Mac app can't do \(tool)")
        }
    }

    // MARK: Reminders

    private func remindersAccess() async throws {
        guard try await store.requestFullAccessToReminders() else {
            throw PhoenixError("Reminders access is off. Allow Phoenix in System Settings › Privacy & Security › Reminders.")
        }
    }

    private func fetchOpenReminders(in lists: [EKCalendar]?) async -> [EKReminder] {
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
        return await withCheckedContinuation { c in store.fetchReminders(matching: predicate) { c.resume(returning: $0 ?? []) } }
    }

    private func reminderList(named name: String?) -> [EKCalendar]? {
        guard let name else { return nil }
        let match = store.calendars(for: .reminder).filter { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame }
        return match.isEmpty ? nil : match
    }

    private func remindersList(list: String?) async throws -> String {
        try await remindersAccess()
        let items = await fetchOpenReminders(in: reminderList(named: list))
            .sorted { ($0.dueDateComponents?.date ?? .distantFuture) < ($1.dueDateComponents?.date ?? .distantFuture) }
            .prefix(100)
        if items.isEmpty { return "No open reminders." }
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM HH:mm"
        return items.map { r in
            var line = "• \(r.title ?? "(untitled)")"
            if let due = r.dueDateComponents?.date { line += " (due \(f.string(from: due)))" }
            line += " [\(r.calendar.title)] [id:\(r.calendarItemIdentifier)]"
            return line
        }.joined(separator: "\n")
    }

    private func remindersAdd(title: String, due: String?, list: String?, notes: String?) async throws -> String {
        try await remindersAccess()
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.notes = notes
        reminder.calendar = reminderList(named: list)?.first ?? store.defaultCalendarForNewReminders()
        if let due, let date = Self.parseISO(due) {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            reminder.addAlarm(EKAlarm(absoluteDate: date))
        }
        try store.save(reminder, commit: true)
        return "Added reminder \"\(title)\" to \(reminder.calendar.title)."
    }

    private func remindersComplete(id: String) async throws -> String {
        try await remindersAccess()
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw PhoenixError("no reminder with that id")
        }
        reminder.isCompleted = true
        try store.save(reminder, commit: true)
        return "Marked \"\(reminder.title ?? "reminder")\" as done."
    }

    /// For proactive nudges: open reminders due within the next `minutes` (or in the last hour).
    private func remindersDueJSON(minutes: Int) async throws -> String {
        guard (try? await store.requestFullAccessToReminders()) == true else { return "[]" }
        let now = Date()
        let items = await fetchOpenReminders(in: nil).compactMap { r -> [String: Any]? in
            guard let due = r.dueDateComponents?.date,
                  due > now.addingTimeInterval(-3600), due <= now.addingTimeInterval(Double(minutes) * 60) else { return nil }
            return ["id": r.calendarItemIdentifier, "title": r.title ?? "Reminder", "due": ISO8601DateFormatter().string(from: due)]
        }
        return String(data: try JSONSerialization.data(withJSONObject: items), encoding: .utf8) ?? "[]"
    }

    // MARK: Calendar

    private func calendarAccess() async throws {
        guard try await store.requestFullAccessToEvents() else {
            throw PhoenixError("Calendar access is off. Allow Phoenix in System Settings › Privacy & Security › Calendars.")
        }
    }

    private func calendarAdd(title: String, start: String, end: String, location: String?, notes: String?) async throws -> String {
        try await calendarAccess()
        guard let s = Self.parseISO(start), let e = Self.parseISO(end) else { throw PhoenixError("invalid start or end time") }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = s
        event.endDate = e
        event.location = location
        event.notes = notes
        event.calendar = store.defaultCalendarForNewEvents
        try store.save(event, span: .thisEvent)
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM HH:mm"
        return "Added \"\(title)\" on \(f.string(from: s)) to \(event.calendar.title)."
    }

    /// For proactive nudges: events starting within the next `minutes`.
    private func calendarUpcomingJSON(minutes: Int) async throws -> String {
        guard (try? await store.requestFullAccessToEvents()) == true else { return "[]" }
        let now = Date()
        let predicate = store.predicateForEvents(withStart: now, end: now.addingTimeInterval(Double(minutes) * 60), calendars: nil)
        let iso = ISO8601DateFormatter()
        let items: [[String: Any]] = store.events(matching: predicate)
            .filter { !$0.isAllDay && $0.startDate >= now }
            .map { ["title": $0.title ?? "Event", "start": iso.string(from: $0.startDate), "location": $0.location ?? ""] }
        return String(data: try JSONSerialization.data(withJSONObject: items), encoding: .utf8) ?? "[]"
    }

    // MARK: Contacts & Messages

    private func contactsSearch(_ name: String) async throws -> String {
        guard try await contacts.requestAccess(for: .contacts) else {
            throw PhoenixError("Contacts access is off. Allow Phoenix in System Settings › Privacy & Security › Contacts.")
        }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
                    CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
        var found = try contacts.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)
        if found.isEmpty {
            // Nicknames like "Mom" aren't covered by name matching: scan nicknames too.
            let request = CNContactFetchRequest(keysToFetch: keys)
            try contacts.enumerateContacts(with: request) { c, stop in
                if c.nickname.localizedCaseInsensitiveContains(name) { found.append(c) }
                if found.count >= 10 { stop.pointee = true }
            }
        }
        if found.isEmpty { return "No contact matches \"\(name)\"." }
        return found.prefix(10).map { c in
            var parts = ["\(c.givenName) \(c.familyName)".trimmingCharacters(in: .whitespaces)]
            if !c.nickname.isEmpty { parts[0] += " (\(c.nickname))" }
            if parts[0].isEmpty { parts[0] = c.organizationName }
            for p in c.phoneNumbers.prefix(3) {
                parts.append("\(CNLabeledValue<NSString>.localizedString(forLabel: p.label ?? "phone")): \(p.value.stringValue)")
            }
            for e in c.emailAddresses.prefix(2) { parts.append("email: \(e.value)") }
            return parts.joined(separator: " — ")
        }.joined(separator: "\n")
    }

    private func messagesSend(to recipient: String, text: String) throws -> String {
        guard !recipient.isEmpty, !text.isEmpty else { throw PhoenixError("missing recipient or text") }
        let script = """
        tell application "Messages"
            set svc to 1st account whose service type = iMessage
            send "\(Self.escape(text))" to participant "\(Self.escape(recipient))" of svc
        end tell
        """
        try Self.runAppleScript(script)
        return "iMessage sent."
    }

    // MARK: Notes & apps

    private func notesCreate(title: String, body: String) throws -> String {
        let html = "<h1>\(Self.html(title))</h1>" + body.split(separator: "\n", omittingEmptySubsequences: false)
            .map { "<div>\(Self.html(String($0)))</div>" }.joined()
        try Self.runAppleScript("""
        tell application "Notes"
            make new note with properties {name:"\(Self.escape(title))", body:"\(Self.escape(html))"}
        end tell
        """)
        return "Created Apple Note \"\(title)\"."
    }

    private func appOpen(_ target: String) throws -> String {
        if let url = URL(string: target), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            guard NSWorkspace.shared.open(url) else { throw PhoenixError("couldn't open \(target)") }
            return "Opened \(url.host ?? target) in the browser."
        }
        let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
        let name = target.hasSuffix(".app") ? target : "\(target).app"
        for dir in dirs {
            if let match = (try? FileManager.default.contentsOfDirectory(atPath: dir))?
                .first(where: { $0.localizedCaseInsensitiveCompare(name) == .orderedSame }) {
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: dir).appendingPathComponent(match),
                                                   configuration: NSWorkspace.OpenConfiguration())
                return "Opened \(match.replacingOccurrences(of: ".app", with: ""))."
            }
        }
        throw PhoenixError("no app called \(target) found")
    }

    // MARK: Helpers

    static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    static func html(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    static func runAppleScript(_ source: String) throws {
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        if let error {
            let message = error[NSAppleScript.errorMessage] as? String ?? "AppleScript failed"
            if (error[NSAppleScript.errorNumber] as? Int) == -1743 {
                throw PhoenixError("Phoenix isn't allowed to control that app. Allow it in System Settings › Privacy & Security › Automation.")
            }
            throw PhoenixError(message)
        }
    }
}
