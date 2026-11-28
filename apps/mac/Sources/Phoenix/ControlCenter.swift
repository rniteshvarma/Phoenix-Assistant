import AppKit
import SwiftUI

// MARK: - Window

/// Phoenix Control Center: name and wake phrase, appearance, memory, skills, connectors,
/// API keys and conversation history. Talks to the core over the same private connection
/// as the Summon Bar; nothing here is reachable from a browser.
@MainActor
final class ControlCenterWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    let model: ControlCenterModel

    init(core: CoreClient, state: AppState) {
        model = ControlCenterModel(core: core, state: state)
    }

    func show(section: ControlCenterModel.Section? = nil) {
        if let section { model.section = section }
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.isReleasedWhenClosed = false
            w.minSize = NSSize(width: 820, height: 520)
            w.appearance = NSAppearance(named: .darkAqua)
            w.backgroundColor = NSColor(red: 0.055, green: 0.058, blue: 0.072, alpha: 1)
            w.contentView = NSHostingView(rootView: ControlCenterView(model: model, state: model.state))
            w.center()
            w.delegate = self
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        Task { await model.reload() }
    }
}

// MARK: - Model

struct MemoryRow: Identifiable { let id: Int; let kind: String; let subject: String?; let text: String; let createdAt: Double }
struct SkillRow: Identifiable { let id: Int; let name: String; let description: String; let steps: String; let enabled: Bool }
struct ConnectorRow: Identifiable { let id: String; let name: String; let description: String; let enabled: Bool; let onMac: Bool; let status: String? }
struct KeyRow: Identifiable { var id: String { name }; let name: String; let label: String; let saved: Bool; let source: String?; let hint: String? }
struct HistoryRow: Identifiable { let id: String; let title: String; let preview: String; let updatedAt: Double; let turns: Int }
struct TranscriptLine: Identifiable { let id: Int; let role: String; let text: String }
struct McpToolRow: Identifiable { var id: String { name }; let name: String; let title: String; let asks: Bool }
struct McpRow: Identifiable { let id: String; let name: String; let transport: String; let enabled: Bool; let status: String; let error: String?; let tools: [McpToolRow] }
struct McpPreset: Identifiable { var id: String { preset }; let preset: String; let name: String; let transport: String; let url: String?; let command: String?; let args: [String]; let tokenEnv: String?; let tokenHelp: String }

@MainActor
final class ControlCenterModel: ObservableObject {
    enum Section: String, CaseIterable, Identifiable {
        case general = "General", appearance = "Appearance", memory = "Memory", skills = "Skills",
             connectors = "Connectors", keys = "API Keys", backups = "Backups", history = "History"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .general: return "gearshape"
            case .appearance: return "paintpalette"
            case .memory: return "brain.head.profile"
            case .skills: return "sparkles"
            case .connectors: return "puzzlepiece.extension"
            case .keys: return "key"
            case .backups: return "lock.shield"
            case .history: return "clock.arrow.circlepath"
            }
        }
    }

    let core: CoreClient
    let state: AppState
    @Published var section: Section = .general
    @Published var message = ""
    @Published var messageIsError = false
    @Published var busy = false

    // General
    @Published var name = Persona.name
    @Published var wakePhrase = Persona.wakePhrase
    @Published var proactiveOn = true
    @Published var briefTime = "08:30"
    @Published var weekdaysOnly = false
    @Published var quietStart = "22:00"
    @Published var quietEnd = "07:30"
    @Published var meetingLead = 10
    @Published var screenApps: [String] = []
    @Published var newApp = ""

    // Appearance
    @Published var themeID = Theme.current.id
    @Published var bootAnimation = Theme.bootAnimation

    // Memory
    @Published var memories: [MemoryRow] = []
    @Published var memoryFilter = "all"
    @Published var memoryQuery = ""
    @Published var newKind = "fact"
    @Published var newSubject = ""
    @Published var newText = ""
    @Published var editingMemory: Int?
    @Published var editText = ""
    @Published var editSubject = ""

    // Skills
    @Published var skills: [SkillRow] = []
    @Published var skillID: Int?
    @Published var skillName = ""
    @Published var skillDescription = ""
    @Published var skillSteps = ""
    @Published var skillEnabled = true

    // Connectors, keys
    @Published var connectors: [ConnectorRow] = []
    @Published var keys: [KeyRow] = []
    @Published var keyInputs: [String: String] = [:]
    /// (label, cost USD, calls, cache rate) for today / 7 days / 30 days.
    @Published var usage: [(String, Double, Int, Double)] = []

    // Backups
    @Published var backupReady = false
    @Published var backupDir = ""
    @Published var backupNightly = true
    @Published var lastBackup: Double?
    @Published var lastBackupFile: String?
    @Published var backupError: String?
    @Published var pass1 = ""
    @Published var pass2 = ""

    // Third-party connectors (MCP)
    @Published var mcp: [McpRow] = []
    @Published var presets: [McpPreset] = []
    @Published var addingConnector = false
    @Published var draftPreset = "custom-http"
    @Published var draftName = ""
    @Published var draftTransport = "http"
    @Published var draftURL = ""
    @Published var draftCommand = ""
    @Published var draftArgs = ""
    @Published var draftTokenEnv = ""
    @Published var draftToken = ""
    @Published var tokenHelp = ""

    // History
    @Published var history: [HistoryRow] = []
    @Published var historyQuery = ""
    @Published var historyID: String?
    @Published var transcript: [TranscriptLine] = []

    init(core: CoreClient, state: AppState) {
        self.core = core
        self.state = state
    }

    private func call(_ request: [String: Any]) async throws -> Any {
        try await core.admin(request)
    }

    func say(_ text: String, error: Bool = false) {
        message = text
        messageIsError = error
        if !error {
            let shown = text
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                if self?.message == shown { self?.message = "" }
            }
        }
    }

    private func attempt(_ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await work() } catch { say(error.localizedDescription, error: true) }
    }

    func reload() async {
        await attempt {
            let o = try await call(["op": "overview"]) as? [String: Any] ?? [:]
            if let p = o["proactive"] as? [String: Any] {
                proactiveOn = p["enabled"] as? Bool ?? true
                briefTime = p["briefTime"] as? String ?? "08:30"
                weekdaysOnly = (p["briefDays"] as? String) == "weekdays"
                quietStart = p["quietStart"] as? String ?? "22:00"
                quietEnd = p["quietEnd"] as? String ?? "07:30"
                meetingLead = p["meetingLead"] as? Int ?? 10
            }
            screenApps = o["screenApps"] as? [String] ?? []
            connectors = Self.parseConnectors(o["connectors"])
            applyBackup(o["backup"])
            if let u = try? await call(["op": "usage"]) as? [String: Any] {
                usage = [("Today", "today"), ("Last 7 days", "week"), ("Last 30 days", "month")].map { label, key in
                    let r = u[key] as? [String: Any] ?? [:]
                    return (label, (r["cost"] as? NSNumber)?.doubleValue ?? 0, (r["calls"] as? NSNumber)?.intValue ?? 0, (r["cacheRate"] as? NSNumber)?.doubleValue ?? 0)
                }
            }
            mcp = Self.parseMcp(o["mcp"])
            presets = (o["mcpPresets"] as? [[String: Any]] ?? []).map {
                McpPreset(preset: $0["preset"] as? String ?? "", name: $0["name"] as? String ?? "", transport: $0["transport"] as? String ?? "http",
                          url: $0["url"] as? String, command: $0["command"] as? String, args: $0["args"] as? [String] ?? [],
                          tokenEnv: $0["tokenEnv"] as? String, tokenHelp: $0["tokenHelp"] as? String ?? "")
            }
            keys = Self.parseKeys(o["keys"])
            if let coreName = o["name"] as? String, coreName != Persona.name {
                // Keep the core in step with the name chosen here.
                _ = try? await call(["op": "settings.set", "name": Persona.name])
            }
            try await loadMemories()
            try await loadSkills()
            try await loadHistory()
            if message.hasPrefix("The Phoenix core") { message = "" }
        }
    }

    // MARK: General

    func saveGeneral() async {
        await attempt {
            let n = name.trimmingCharacters(in: .whitespaces)
            guard !n.isEmpty, n.count <= 30 else { throw PhoenixError("Give your assistant a name (up to 30 characters).") }
            let wake = wakePhrase.trimmingCharacters(in: .whitespaces)
            guard wake.split(separator: " ").count >= 2 else {
                throw PhoenixError("Use at least two words for the wake phrase (like \"\(n), rise\") so it doesn't trigger by accident.")
            }
            for t in [briefTime, quietStart, quietEnd] where t.range(of: "^([01]\\d|2[0-3]):[0-5]\\d$", options: .regularExpression) == nil {
                throw PhoenixError("Times need the HH:MM format, like 08:30 (got \"\(t)\").")
            }
            Persona.set(name: n, wakePhrase: wake)
            state.assistantName = Persona.name
            _ = try await call(["op": "settings.set", "name": n, "screenApps": screenApps,
                                "proactive": ["enabled": proactiveOn, "briefTime": briefTime, "briefDays": weekdaysOnly ? "weekdays" : "daily",
                                              "quietStart": quietStart, "quietEnd": quietEnd, "meetingLead": meetingLead]])
            say("Saved. Say \"\(Persona.wakePhrase)\" to summon \(Persona.name).")
        }
    }

    func addApp() {
        let a = newApp.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty, !screenApps.contains(where: { $0.caseInsensitiveCompare(a) == .orderedSame }) else { return }
        screenApps.append(a)
        newApp = ""
    }

    // MARK: Appearance

    func pickTheme(_ id: String) {
        Theme.set(id)
        themeID = id
        state.themeID = id
    }

    func setBootAnimation(_ on: Bool) {
        Theme.bootAnimation = on
        bootAnimation = on
    }

    // MARK: Memory

    func loadMemories() async throws {
        let list = try await call(["op": "memory.list"]) as? [[String: Any]] ?? []
        memories = list.map {
            MemoryRow(id: $0["id"] as? Int ?? 0, kind: $0["kind"] as? String ?? "fact", subject: $0["subject"] as? String,
                      text: $0["text"] as? String ?? "", createdAt: $0["createdAt"] as? Double ?? 0)
        }.reversed()
    }

    var filteredMemories: [MemoryRow] {
        memories.filter { m in
            (memoryFilter == "all" ? m.kind != "episode" : m.kind == memoryFilter) &&
                (memoryQuery.isEmpty || m.text.localizedCaseInsensitiveContains(memoryQuery) || (m.subject ?? "").localizedCaseInsensitiveContains(memoryQuery))
        }
    }

    func addMemory() async {
        await attempt {
            var req: [String: Any] = ["op": "memory.add", "kind": newKind, "text": newText]
            if !newSubject.trimmingCharacters(in: .whitespaces).isEmpty { req["subject"] = newSubject }
            _ = try await call(req)
            newText = ""
            newSubject = ""
            try await loadMemories()
            say("Remembered.")
        }
    }

    func beginEdit(_ m: MemoryRow) {
        editingMemory = m.id
        editText = m.text
        editSubject = m.subject ?? ""
    }

    func saveEdit() async {
        guard let id = editingMemory else { return }
        await attempt {
            let row = memories.first { $0.id == id }
            var req: [String: Any] = ["op": "memory.update", "id": id, "text": editText]
            if row?.subject != nil || !editSubject.isEmpty { req["subject"] = editSubject.isEmpty ? NSNull() : editSubject }
            _ = try await call(req)
            editingMemory = nil
            try await loadMemories()
            say("Updated.")
        }
    }

    func deleteMemory(_ m: MemoryRow) async {
        guard confirm("Forget this?", m.text) else { return }
        await attempt {
            _ = try await call(["op": "memory.remove", "id": m.id])
            try await loadMemories()
        }
    }

    // MARK: Skills

    func loadSkills() async throws {
        let list = try await call(["op": "skills.list"]) as? [[String: Any]] ?? []
        skills = list.map {
            SkillRow(id: $0["id"] as? Int ?? 0, name: $0["name"] as? String ?? "", description: $0["description"] as? String ?? "",
                     steps: $0["steps"] as? String ?? "", enabled: $0["enabled"] as? Bool ?? true)
        }
    }

    func selectSkill(_ s: SkillRow?) {
        skillID = s?.id
        skillName = s?.name ?? ""
        skillDescription = s?.description ?? ""
        skillSteps = s?.steps ?? "1. \n2. \n3. "
        skillEnabled = s?.enabled ?? true
    }

    func saveSkill() async {
        await attempt {
            var req: [String: Any] = ["op": "skills.save", "name": skillName, "description": skillDescription, "steps": skillSteps, "enabled": skillEnabled]
            if let skillID { req["id"] = skillID }
            let r = try await call(req) as? [String: Any]
            try await loadSkills()
            skillID = r?["id"] as? Int ?? skillID
            say("Skill saved. \(Persona.name) will use it when a request matches.")
        }
    }

    func toggleSkill(_ s: SkillRow) async {
        await attempt {
            _ = try await call(["op": "skills.save", "id": s.id, "name": s.name, "description": s.description, "steps": s.steps, "enabled": !s.enabled])
            try await loadSkills()
            if skillID == s.id { skillEnabled = !s.enabled }
        }
    }

    func deleteSkill() async {
        guard let id = skillID, confirm("Delete the skill \"\(skillName)\"?", "This can't be undone.") else { return }
        await attempt {
            _ = try await call(["op": "skills.remove", "id": id])
            selectSkill(nil)
            skillID = nil
            try await loadSkills()
        }
    }

    // MARK: Connectors & keys

    static func parseConnectors(_ value: Any?) -> [ConnectorRow] {
        (value as? [[String: Any]] ?? []).map {
            ConnectorRow(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "", description: $0["description"] as? String ?? "",
                         enabled: $0["enabled"] as? Bool ?? true, onMac: $0["onMac"] as? Bool ?? false, status: $0["status"] as? String)
        }
    }

    static func parseKeys(_ value: Any?) -> [KeyRow] {
        (value as? [[String: Any]] ?? []).map {
            KeyRow(name: $0["name"] as? String ?? "", label: $0["label"] as? String ?? "", saved: $0["saved"] as? Bool ?? false,
                   source: $0["source"] as? String, hint: $0["hint"] as? String)
        }
    }

    func setConnector(_ c: ConnectorRow, _ on: Bool) async {
        await attempt {
            let r = try await call(["op": "connectors.set", "id": c.id, "enabled": on]) as? [String: Any]
            connectors = Self.parseConnectors(r?["connectors"])
        }
    }

    func saveKey(_ name: String) async {
        let value = (keyInputs[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        await attempt {
            let r = try await call(["op": "keys.set", "name": name, "value": value]) as? [String: Any]
            keyInputs[name] = ""
            keys = Self.parseKeys(r?["keys"])
            say("Saved in your Mac's Keychain. \(Persona.name) uses it right away.")
        }
    }

    func removeKey(_ k: KeyRow) async {
        guard confirm("Remove the \(k.label)?", "\(Persona.name) can't use this service until you add a key again.") else { return }
        await attempt {
            let r = try await call(["op": "keys.remove", "name": k.name]) as? [String: Any]
            keys = Self.parseKeys(r?["keys"])
        }
    }

    func testKey() async {
        await attempt {
            let r = try await call(["op": "keys.test"]) as? [String: Any]
            say(r?["message"] as? String ?? "", error: (r?["ok"] as? Bool) != true)
        }
    }

    // MARK: Backups

    func applyBackup(_ value: Any?) {
        guard let b = value as? [String: Any] else { return }
        backupReady = b["ready"] as? Bool ?? false
        backupDir = b["dir"] as? String ?? ""
        backupNightly = b["nightly"] as? Bool ?? true
        lastBackup = b["lastBackup"] as? Double
        lastBackupFile = b["lastFile"] as? String
        backupError = b["lastError"] as? String
    }

    func setupBackups() async {
        guard pass1 == pass2 else { say("The two passphrases don't match.", error: true); return }
        await attempt {
            applyBackup(try await call(["op": "backup.setup", "passphrase": pass1]))
            pass1 = ""
            pass2 = ""
            say("Backups are on. Your first backup is saved. Keep the passphrase somewhere safe.")
        }
    }

    func backupNow() async {
        await attempt {
            applyBackup(try await call(["op": "backup.now"]))
            say("Backed up.")
        }
    }

    func saveBackupSettings() async {
        await attempt {
            applyBackup(try await call(["op": "backup.settings", "dir": backupDir, "nightly": backupNightly]))
            say("Saved.")
        }
    }

    func revealBackups() {
        NSWorkspace.shared.selectFile(lastBackupFile, inFileViewerRootedAtPath: backupDir)
    }

    // MARK: Third-party connectors

    static func parseMcp(_ value: Any?) -> [McpRow] {
        (value as? [[String: Any]] ?? []).map { c in
            McpRow(id: c["id"] as? String ?? "", name: c["name"] as? String ?? "", transport: c["transport"] as? String ?? "",
                   enabled: c["enabled"] as? Bool ?? true, status: c["status"] as? String ?? "", error: c["error"] as? String,
                   tools: (c["tools"] as? [[String: Any]] ?? []).map {
                       McpToolRow(name: $0["name"] as? String ?? "", title: $0["title"] as? String ?? "", asks: ($0["tier"] as? Int ?? 2) > 0)
                   })
        }
    }

    func pickPreset(_ id: String) {
        draftPreset = id
        tokenHelp = ""
        if let p = presets.first(where: { $0.preset == id }) {
            draftName = p.name
            draftTransport = p.transport
            draftURL = p.url ?? ""
            draftCommand = p.command ?? ""
            draftArgs = p.args.joined(separator: " ")
            draftTokenEnv = p.tokenEnv ?? ""
            tokenHelp = p.tokenHelp
        } else {
            draftName = ""
            draftTransport = id == "custom-command" ? "stdio" : "http"
            draftURL = ""; draftCommand = ""; draftArgs = ""; draftTokenEnv = ""
        }
        addingConnector = true
    }

    func addConnector() async {
        await attempt {
            var req: [String: Any] = ["op": "mcp.add", "name": draftName, "transport": draftTransport]
            if draftPreset != "custom-http" && draftPreset != "custom-command" { req["preset"] = draftPreset }
            if draftTransport == "http" { req["url"] = draftURL.trimmingCharacters(in: .whitespaces) }
            else {
                req["command"] = draftCommand.trimmingCharacters(in: .whitespaces)
                req["args"] = draftArgs.split(separator: " ").map(String.init)
                if !draftTokenEnv.isEmpty { req["tokenEnv"] = draftTokenEnv }
            }
            if !draftToken.isEmpty { req["token"] = draftToken }
            let r = try await call(req) as? [String: Any]
            mcp = Self.parseMcp(r?["mcp"])
            draftToken = ""
            addingConnector = false
            let c = r?["connector"] as? [String: Any]
            if c?["status"] as? String == "connected" {
                say("\(draftName) connected with \((c?["tools"] as? [Any])?.count ?? 0) tools.")
            } else {
                say("\(draftName) was added but didn't connect: \(c?["error"] as? String ?? "unknown error")", error: true)
            }
        }
    }

    func setMcp(_ c: McpRow, _ on: Bool) async {
        await attempt { mcp = Self.parseMcp((try await call(["op": "mcp.set", "id": c.id, "enabled": on]) as? [String: Any])?["mcp"]) }
    }

    func reconnectMcp(_ c: McpRow) async {
        await attempt { mcp = Self.parseMcp((try await call(["op": "mcp.reconnect", "id": c.id]) as? [String: Any])?["mcp"]) }
    }

    func removeMcp(_ c: McpRow) async {
        guard confirm("Remove \(c.name)?", "Its tools go away and its saved token is deleted from the Keychain.") else { return }
        await attempt { mcp = Self.parseMcp((try await call(["op": "mcp.remove", "id": c.id]) as? [String: Any])?["mcp"]) }
    }

    // MARK: History

    func loadHistory() async throws {
        let list = try await call(["op": "history.list"]) as? [[String: Any]] ?? []
        history = list.map {
            HistoryRow(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "", preview: $0["preview"] as? String ?? "",
                       updatedAt: $0["updatedAt"] as? Double ?? 0, turns: $0["turns"] as? Int ?? 0)
        }
    }

    var filteredHistory: [HistoryRow] {
        historyQuery.isEmpty ? history : history.filter {
            $0.title.localizedCaseInsensitiveContains(historyQuery) || $0.preview.localizedCaseInsensitiveContains(historyQuery)
        }
    }

    func openHistory(_ h: HistoryRow) async {
        historyID = h.id
        await attempt {
            let r = try await call(["op": "history.get", "id": h.id]) as? [String: Any]
            transcript = (r?["entries"] as? [[String: Any]] ?? []).enumerated().map {
                TranscriptLine(id: $0.offset, role: $0.element["role"] as? String ?? "", text: $0.element["text"] as? String ?? "")
            }
        }
    }

    func deleteHistory() async {
        guard let id = historyID, confirm("Delete this conversation?", "It's removed from this Mac and can't be recovered.") else { return }
        await attempt {
            _ = try await call(["op": "history.remove", "id": id])
            historyID = nil
            transcript = []
            try await loadHistory()
        }
    }

    func copyTranscript() {
        let text = transcript.map { "\($0.role == "you" ? "You" : $0.role == "action" ? "•" : Persona.name): \($0.text)" }.joined(separator: "\n\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        say("Copied the conversation.")
    }

    private func confirm(_ title: String, _ detail: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

