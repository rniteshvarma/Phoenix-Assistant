import AppKit
import SwiftUI

// MARK: - Design system ("Obsidian")

/// Neutrals for the Control Center: obsidian blacks, warm whites, hairlines that catch the light.
enum Obsidian {
    static var bg: Color { Theme.current.base }
    static var sidebar: Color { Theme.current.raised }
    static let raised = Color(red: 0.075, green: 0.078, blue: 0.098)
    static let text = Color(red: 0.95, green: 0.94, blue: 0.92)
    static let muted = Color.white.opacity(0.62)
    static let faint = Color.white.opacity(0.38)
    static let hairline = Color.white.opacity(0.07)
    static let good = Color(red: 0.42, green: 0.86, blue: 0.64)
    static let bad = Color(red: 1.0, green: 0.42, blue: 0.45)
    static let warn = Color(red: 1.0, green: 0.80, blue: 0.42)

    /// Light catching the top edge of a surface.
    static var rim: LinearGradient {
        LinearGradient(colors: [Color.white.opacity(0.14), Color.white.opacity(0.04), Color.white.opacity(0.02)], startPoint: .top, endPoint: .bottom)
    }
    static var accentRim: LinearGradient {
        LinearGradient(colors: [Fire.gold.opacity(0.7), Fire.ember.opacity(0.25), Fire.ember.opacity(0.05)], startPoint: .top, endPoint: .bottom)
    }
    static var metal: LinearGradient {
        LinearGradient(colors: [Fire.core, Fire.gold, Fire.flame, Fire.ember], startPoint: .top, endPoint: .bottom)
    }
}

/// Monospaced "HUD" label.
struct HUDLabel: View {
    let text: String
    var color: Color = Fire.amber
    var body: some View {
        Text(text.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.8).foregroundStyle(color)
    }
}

extension Fire {
    static var amber: Color { Theme.current.amber }
}

/// The Phoenix logo (Resources/PhoenixMark.png, drawn by tools/PhoenixIcon.swift).
struct PhoenixLogo: View {
    var size: CGFloat = 34
    private static let image: NSImage? = {
        if let url = Bundle.main.url(forResource: "PhoenixMark", withExtension: "png") { return NSImage(contentsOf: url) }
        return NSImage(named: "PhoenixMark")
    }()

    var body: some View {
        if let img = Self.image {
            Image(nsImage: img).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .shadow(color: Fire.ember.opacity(0.55), radius: size * 0.25)
        } else {
            CoreOrb(size: size, active: false, riseStartedAt: .distantPast)
        }
    }
}

/// Faint engineering grid with a glow in the corner.
struct ObsidianBackdrop: View {
    var body: some View {
        ZStack {
            Obsidian.bg
            Canvas { ctx, size in
                var path = Path()
                stride(from: 0.0, through: size.width, by: 28).forEach { x in path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)) }
                stride(from: 0.0, through: size.height, by: 28).forEach { y in path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)) }
                ctx.stroke(path, with: .color(Color.white.opacity(0.018)), lineWidth: 0.5)
            }
            // Soft, out-of-focus glows in the theme colors.
            RadialGradient(colors: [Fire.ember.opacity(Theme.current.glow), Fire.deep.opacity(Theme.current.glow * 0.4), .clear], center: .topLeading, startRadius: 0, endRadius: 680)
            RadialGradient(colors: [Fire.flame.opacity(Theme.current.glow * 0.55), .clear], center: UnitPoint(x: 0.85, y: 0.25), startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Fire.gold.opacity(Theme.current.glow * 0.3), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 520)
            // Darken toward the bottom, like light falling off.
            LinearGradient(colors: [.clear, Color.black.opacity(0.35)], startPoint: .center, endPoint: .bottom)
        }
        .ignoresSafeArea()
    }
}

extension Fire {
    static var deep: Color { Theme.current.deep }
}

/// Glass card with a lit top edge.
struct Card<Content: View>: View {
    var title: String? = nil
    var subtitle: String? = nil
    var label: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if title != nil || label != nil {
                VStack(alignment: .leading, spacing: 4) {
                    if let label { HUDLabel(text: label) }
                    if let title { Text(title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(Obsidian.text) }
                    if let subtitle {
                        Text(subtitle).font(.system(size: 12)).foregroundStyle(Obsidian.muted).fixedSize(horizontal: false, vertical: true).lineSpacing(2)
                    }
                }
            }
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [Color.white.opacity(0.045), Color.white.opacity(0.018)], startPoint: .top, endPoint: .bottom))
        )
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Obsidian.rim, lineWidth: 1))
    }
}

struct FieldLabel: View {
    let text: String
    var body: some View { HUDLabel(text: text, color: Obsidian.muted) }
}

/// Dark inset field with a hairline that lights up in the accent.
struct InsetField: ViewModifier {
    var mono = false
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.system(size: 13, design: mono ? .monospaced : .default))
            .foregroundStyle(Obsidian.text)
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.black.opacity(0.38)))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
    }
}

extension View {
    func insetField(mono: Bool = false) -> some View { modifier(InsetField(mono: mono)) }
}

struct PrimaryButton: View {
    let title: String
    var icon: String? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 11, weight: .bold)) }
                Text(title).font(.system(size: 12.5, weight: .semibold))
            }
            .foregroundStyle(Theme.current.onAccent)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(Capsule().fill(Theme.current.buttonFill))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6).blendMode(.overlay))
            .shadow(color: Fire.ember.opacity(0.45), radius: 10, y: 2)
        }
        .buttonStyle(.plain)
    }
}

struct GhostButton: View {
    let title: String
    var icon: String? = nil
    var danger = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 11, weight: .semibold)) }
                Text(title).font(.system(size: 12.5, weight: .medium))
            }
            .foregroundStyle(danger ? Obsidian.bad : Obsidian.text)
            .padding(.horizontal, 14).padding(.vertical, 7.5)
            .background(Capsule().fill(Color.white.opacity(0.04)))
            .overlay(Capsule().strokeBorder(danger ? Obsidian.bad.opacity(0.4) : Color.white.opacity(0.12), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct Badge: View {
    let text: String
    var color: Color = Obsidian.muted
    var body: some View {
        Text(text).font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(Capsule().fill(color.opacity(0.08)))
            .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 0.8))
    }
}

struct Pill: View {
    let text: String
    let selected: Bool
    var count: Int? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(text)
                if let count { Text("\(count)").font(.system(size: 10.5, weight: .semibold, design: .monospaced)).opacity(0.7) }
            }
            .font(.system(size: 12, weight: selected ? .semibold : .regular))
            .foregroundStyle(selected ? Theme.current.onAccent : Obsidian.muted)
            .padding(.horizontal, 11).padding(.vertical, 5.5)
            .background(Capsule().fill(selected ? AnyShapeStyle(Theme.current.buttonFill) : AnyShapeStyle(Color.white.opacity(0.045))))
            .overlay(Capsule().strokeBorder(selected ? Color.clear : Color.white.opacity(0.08), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Window content

extension ControlCenterModel.Section {
    var subtitle: String {
        let n = Persona.name
        switch self {
        case .general: return "Identity, wake phrase, proactive briefings and the apps \(n) may operate."
        case .appearance: return "Themes and motion for the Summon Bar, overlays and this window."
        case .memory: return "Everything \(n) knows about you. The profile travels with every request; the rest only when it's relevant."
        case .skills: return "Routines \(n) follows when a request matches. Say \"\(n), learn this: …\" to add one by voice."
        case .connectors: return "What \(n) can reach. Anything that sends, posts, deletes or runs still asks you first."
        case .keys: return "Stored in your Mac's Keychain. After saving, only the first few characters are ever shown."
        case .backups: return "Encrypted copies of everything \(n) knows, locked with a passphrase only you have."
        case .history: return "Every conversation, as you saw it. Search, copy or delete."
        }
    }
}

struct ControlCenterView: View {
    @ObservedObject var model: ControlCenterModel
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(LinearGradient(colors: [Color.white.opacity(0.09), Color.white.opacity(0.02)], startPoint: .top, endPoint: .bottom)).frame(width: 1)
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        section
                    }
                    .padding(.horizontal, 34).padding(.top, 40).padding(.bottom, 34)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !model.message.isEmpty { toast }
            }
        }
        .background(ObsidianBackdrop())
        .id("\(state.themeID)")
        .preferredColorScheme(.dark)
        .tint(Fire.ember)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                HUDLabel(text: "Control Center", color: Obsidian.faint)
                Text("/").font(.system(size: 10, design: .monospaced)).foregroundStyle(Obsidian.faint)
                HUDLabel(text: model.section.rawValue)
            }
            Text(model.section.rawValue).font(.system(size: 30, weight: .semibold)).tracking(-0.4).foregroundStyle(Obsidian.text)
            Text(model.section.subtitle).font(.system(size: 13)).foregroundStyle(Obsidian.muted)
                .fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(LinearGradient(colors: [Theme.current.highlight.opacity(0.85), Fire.ember.opacity(0.2), .clear], startPoint: .leading, endPoint: .trailing))
                .frame(height: 1).padding(.top, 6)
        }
    }

    private var toast: some View {
        HStack(spacing: 10) {
            Image(systemName: model.messageIsError ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
            Text(model.message).lineLimit(3)
            Spacer()
            Button { model.message = "" } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(Obsidian.muted)
        }
        .font(.system(size: 12.5))
        .foregroundStyle(model.messageIsError ? Obsidian.bad : Obsidian.good)
        .padding(.horizontal, 22).padding(.vertical, 11)
        .background(Color.black.opacity(0.55))
        .overlay(alignment: .top) { Rectangle().fill(Obsidian.hairline).frame(height: 1) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 12) {
                PhoenixLogo(size: 38)
                VStack(alignment: .leading, spacing: 4) {
                    Text(state.assistantName.uppercased()).font(.system(size: 15, weight: .bold)).tracking(3.2)
                        .foregroundStyle(Obsidian.metal)
                    HStack(spacing: 5) {
                        Circle().fill(state.connected ? Obsidian.good : Obsidian.bad).frame(width: 6, height: 6)
                            .shadow(color: state.connected ? Obsidian.good : Obsidian.bad, radius: 3)
                        HUDLabel(text: state.connected ? "Online" : "Offline", color: state.connected ? Obsidian.good : Obsidian.bad)
                    }
                }
            }
            .padding(.top, 44).padding(.bottom, 26).padding(.horizontal, 18)

            HUDLabel(text: "Manage", color: Obsidian.faint).padding(.horizontal, 20).padding(.bottom, 6)
            ForEach(ControlCenterModel.Section.allCases) { s in
                let selected = model.section == s
                Button { model.section = s } label: {
                    HStack(spacing: 11) {
                        Image(systemName: s.icon).font(.system(size: 13, weight: selected ? .semibold : .regular)).frame(width: 18)
                            .foregroundStyle(selected ? AnyShapeStyle(Obsidian.metal) : AnyShapeStyle(Obsidian.muted))
                        Text(s.rawValue).font(.system(size: 13, weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? Obsidian.text : Obsidian.muted)
                        Spacer()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(selected ? AnyShapeStyle(LinearGradient(colors: [Fire.ember.opacity(0.20), Fire.ember.opacity(0.04)], startPoint: .leading, endPoint: .trailing)) : AnyShapeStyle(Color.clear))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(selected ? AnyShapeStyle(Obsidian.accentRim) : AnyShapeStyle(Color.clear), lineWidth: 1)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 10)
            }
            Spacer()
            VStack(alignment: .leading, spacing: 10) {
                Rectangle().fill(Obsidian.hairline).frame(height: 1)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        HUDLabel(text: "Core · 127.0.0.1", color: Obsidian.faint)
                        HUDLabel(text: "Encrypted · local", color: Obsidian.faint)
                    }
                    Spacer()
                    Button { Task { await model.reload() } } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold)).foregroundStyle(Obsidian.muted)
                            .frame(width: 28, height: 28).background(Circle().fill(Color.white.opacity(0.05)))
                    }
                    .buttonStyle(.plain).help("Refresh")
                }
            }
            .padding(.horizontal, 18).padding(.bottom, 18)
        }
        .frame(width: 232)
        .background(Obsidian.sidebar.opacity(0.92))
    }

    @ViewBuilder private var section: some View {
        switch model.section {
        case .general: GeneralPane(model: model)
        case .appearance: AppearancePane(model: model)
        case .memory: MemoryPane(model: model)
        case .skills: SkillsPane(model: model)
        case .connectors: ConnectorsPane(model: model)
        case .keys: KeysPane(model: model)
        case .backups: BackupsPane(model: model)
        case .history: HistoryPane(model: model)
        }
    }
}

// MARK: - General

struct GeneralPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        Card(title: "Identity", subtitle: "What your assistant is called, and the phrase that wakes it. Two or more words avoids false wake-ups.", label: "Persona") {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Name")
                    TextField("Phoenix", text: $model.name).insetField().frame(width: 230)
                }
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Wake phrase")
                    TextField("\(model.name), rise", text: $model.wakePhrase).insetField().frame(width: 280)
                }
            }
        }
        Card(title: "Proactive", subtitle: "The morning briefing, plus nudges before meetings and when reminders are due.", label: "Briefings") {
            Toggle("Brief me and nudge me", isOn: $model.proactiveOn).toggleStyle(.switch).foregroundStyle(Obsidian.text)
            HStack(alignment: .bottom, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Briefing")
                    TextField("08:30", text: $model.briefTime).insetField(mono: true).frame(width: 76)
                }
                Toggle("Weekdays only", isOn: $model.weekdaysOnly).foregroundStyle(Obsidian.text).padding(.bottom, 8)
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Quiet hours")
                    HStack(spacing: 6) {
                        TextField("22:00", text: $model.quietStart).insetField(mono: true).frame(width: 72)
                        Text("→").foregroundStyle(Obsidian.faint)
                        TextField("07:30", text: $model.quietEnd).insetField(mono: true).frame(width: 72)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Meeting nudge")
                    Stepper("\(model.meetingLead) min before", value: $model.meetingLead, in: 1...120).foregroundStyle(Obsidian.text).padding(.bottom, 5)
                }
            }
        }
        Card(title: "Screen control", subtitle: "Apps it may operate on screen. It asks before every session; banking, payment, password and system apps are never allowed.", label: "Allowed apps") {
            FlowList(items: model.screenApps) { app in
                HStack(spacing: 7) {
                    Text(app)
                    Button { model.screenApps.removeAll { $0 == app } } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                        .buttonStyle(.plain).foregroundStyle(Obsidian.muted)
                }
                .font(.system(size: 12)).foregroundStyle(Obsidian.text)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(Capsule().fill(Color.white.opacity(0.05)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
            }
            HStack(spacing: 10) {
                TextField("Add an app, e.g. Telegram", text: $model.newApp).insetField().frame(width: 280).onSubmit { model.addApp() }
                GhostButton(title: "Add", icon: "plus") { model.addApp() }
            }
        }
        HStack {
            Spacer()
            PrimaryButton(title: "Save changes", icon: "checkmark") { Task { await model.saveGeneral() } }
        }
    }
}

/// Wrapping row of chips.
struct FlowList<Item: Hashable, Chip: View>: View {
    let items: [Item]
    @ViewBuilder let chip: (Item) -> Chip
    var body: some View {
        let rows = stride(from: 0, to: items.count, by: 5).map { Array(items[$0..<min($0 + 5, items.count)]) }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 8) { ForEach(row, id: \.self) { chip($0) } }
            }
        }
    }
}

// MARK: - Appearance

struct AppearancePane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        Card(label: "Theme") {
            let columns = [GridItem(.adaptive(minimum: 132), spacing: 12)]
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                ForEach(Theme.all) { t in
                    let selected = model.themeID == t.id
                    Button { model.pickTheme(t.id) } label: {
                        VStack(spacing: 10) {
                            ZStack {
                                Circle().fill(RadialGradient(colors: [t.core, t.gold, t.ember, t.deep, Color.black], center: UnitPoint(x: 0.42, y: 0.35), startRadius: 1, endRadius: 34))
                                    .frame(width: 52, height: 52)
                                    .shadow(color: t.ember.opacity(selected ? 0.8 : 0.35), radius: selected ? 14 : 6)
                                Circle().strokeBorder(LinearGradient(colors: [t.gold, t.ember.opacity(0.3)], startPoint: .top, endPoint: .bottom), lineWidth: selected ? 1.5 : 0.6)
                                    .frame(width: 64, height: 64).opacity(selected ? 1 : 0.4)
                            }
                            .frame(height: 68)
                            Text(t.name).font(.system(size: 12, weight: selected ? .semibold : .regular)).foregroundStyle(selected ? Obsidian.text : Obsidian.muted)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? Color.white.opacity(0.05) : Color.clear))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? AnyShapeStyle(Obsidian.accentRim) : AnyShapeStyle(Color.clear), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        Card(label: "Preview") {
            HStack(spacing: 22) {
                PhoenixLogo(size: 64)
                CoreOrb(size: 64, active: true, riseStartedAt: .distantPast)
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(model.name.uppercased()) HAS RISEN").font(.system(size: 11, weight: .semibold, design: .monospaced)).tracking(2.4).foregroundStyle(Fire.body)
                    Text("I'm listening…").font(.system(size: 22, weight: .semibold)).foregroundStyle(Obsidian.text)
                }
            }
        }
        Card(label: "Motion") {
            Toggle("Play the boot-up animation when summoned", isOn: Binding(get: { model.bootAnimation }, set: { model.setBootAnimation($0) }))
                .toggleStyle(.switch).foregroundStyle(Obsidian.text)
            Text("It's also skipped when macOS \"Reduce motion\" is on.").font(.system(size: 11.5)).foregroundStyle(Obsidian.muted)
        }
    }
}

// MARK: - Memory

private let memoryKinds: [(String, String)] = [
    ("all", "All"), ("profile", "Profile"), ("person", "People"), ("project", "Projects"), ("fact", "Facts"),
    ("style", "Writing"), ("episode", "Requests"), ("local", "Mac only"),
]

struct MemoryPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        Card(label: "Teach \(Persona.name)") {
            HStack(alignment: .center, spacing: 10) {
                Picker("", selection: $model.newKind) {
                    Text("Profile").tag("profile"); Text("Person").tag("person"); Text("Project").tag("project")
                    Text("Fact").tag("fact"); Text("Writing style").tag("style"); Text("Mac only (never sent)").tag("local")
                }
                .labelsHidden().frame(width: 165)
                if ["person", "project", "local"].contains(model.newKind) {
                    TextField(model.newKind == "person" ? "Name, e.g. Mom (Amma)" : "Name", text: $model.newSubject).insetField().frame(width: 190)
                }
                TextField("What should it remember?", text: $model.newText).insetField().onSubmit { Task { await model.addMemory() } }
                PrimaryButton(title: "Add", icon: "plus") { Task { await model.addMemory() } }
            }
            Text("Passwords, PINs, card and ID numbers are never stored.").font(.system(size: 11.5)).foregroundStyle(Obsidian.faint)
        }
        HStack(spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(memoryKinds, id: \.0) { k in
                        let count = k.0 == "all" ? model.memories.filter { $0.kind != "episode" }.count : model.memories.filter { $0.kind == k.0 }.count
                        Pill(text: k.1, selected: model.memoryFilter == k.0, count: count) { model.memoryFilter = k.0 }.fixedSize()
                    }
                }
                .padding(.vertical, 2)
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Obsidian.muted)
                TextField("Search", text: $model.memoryQuery).textFieldStyle(.plain).font(.system(size: 12.5)).foregroundStyle(Obsidian.text)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Capsule().fill(Color.black.opacity(0.35)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .frame(width: 150)
        }
        VStack(spacing: 8) {
            if model.filteredMemories.isEmpty {
                Text("Nothing here yet.").font(.system(size: 13)).foregroundStyle(Obsidian.muted).frame(maxWidth: .infinity).padding(36)
            }
            ForEach(model.filteredMemories) { m in
                if model.editingMemory == m.id {
                    Card(label: "Editing #\(m.id)") {
                        if m.subject != nil || ["person", "project", "local"].contains(m.kind) {
                            TextField("Name", text: $model.editSubject).insetField()
                        }
                        TextEditor(text: $model.editText).font(.system(size: 13)).frame(minHeight: 76)
                            .scrollContentBackground(.hidden).padding(6)
                            .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.38)))
                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.white.opacity(0.09)))
                        HStack {
                            Spacer()
                            GhostButton(title: "Cancel") { model.editingMemory = nil }
                            PrimaryButton(title: "Save") { Task { await model.saveEdit() } }
                        }
                    }
                } else {
                    MemoryRowView(m: m, model: model)
                }
            }
        }
    }
}

struct MemoryRowView: View {
    let m: MemoryRow
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Rectangle().fill(kindColor).frame(width: 2).clipShape(Capsule())
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Badge(text: label, color: kindColor)
                    if let s = m.subject { Text(s).font(.system(size: 12, weight: .semibold)).foregroundStyle(Fire.gold) }
                    Spacer()
                    Text(Date(timeIntervalSince1970: m.createdAt / 1000).formatted(date: .abbreviated, time: m.kind == "episode" ? .shortened : .omitted))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Obsidian.faint)
                }
                Text(m.text).font(.system(size: 13)).foregroundStyle(Obsidian.text).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(2)
            }
            VStack(spacing: 10) {
                if m.kind != "episode" {
                    Button { model.beginEdit(m) } label: { Image(systemName: "pencil") }.buttonStyle(.plain).foregroundStyle(Obsidian.muted).help("Edit")
                }
                Button { Task { await model.deleteMemory(m) } } label: { Image(systemName: "trash") }.buttonStyle(.plain).foregroundStyle(Obsidian.muted).help("Forget")
            }
            .font(.system(size: 12))
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.028)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Obsidian.rim, lineWidth: 1))
    }

    private var label: String {
        switch m.kind {
        case "profile": return "PROFILE"
        case "person": return "PERSON"
        case "project": return "PROJECT"
        case "style": return "WRITING"
        case "episode": return "REQUEST"
        case "local": return "MAC ONLY"
        default: return "FACT"
        }
    }

    private var kindColor: Color {
        switch m.kind {
        case "profile": return Fire.gold
        case "person": return Fire.flame
        case "project": return Fire.ember
        case "style": return Fire.amber
        case "local": return Obsidian.warn
        default: return Obsidian.muted
        }
    }
}

// MARK: - Skills

struct SkillsPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Button { model.selectSkill(nil) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                        Text("New skill").font(.system(size: 12.5, weight: .semibold))
                        Spacer()
                    }
                    .foregroundStyle(Fire.gold)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4])).foregroundStyle(Fire.ember.opacity(0.5)))
                }
                .buttonStyle(.plain)
                if model.skills.isEmpty {
                    Text("No skills yet. Write one here, or teach one by voice.").font(.system(size: 12)).foregroundStyle(Obsidian.muted).padding(.top, 6)
                }
                ForEach(model.skills) { s in
                    let selected = model.skillID == s.id
                    Button { model.selectSkill(s) } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(s.enabled ? Obsidian.text : Obsidian.muted)
                                Text(s.description).font(.system(size: 11.5)).foregroundStyle(Obsidian.muted).lineLimit(2)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(get: { s.enabled }, set: { _ in Task { await model.toggleSkill(s) } }))
                                .toggleStyle(.switch).labelsHidden().controlSize(.mini)
                        }
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? Fire.ember.opacity(0.12) : Color.white.opacity(0.028)))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? AnyShapeStyle(Obsidian.accentRim) : AnyShapeStyle(Obsidian.rim), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: 270)
            Card(label: model.skillID == nil ? "New skill" : "Edit skill") {
                FieldLabel(text: "Name")
                TextField("My usual Swiggy order", text: $model.skillName).insetField()
                FieldLabel(text: "When to use it")
                TextField("When I ask to order my usual food", text: $model.skillDescription).insetField()
                FieldLabel(text: "Steps")
                TextEditor(text: $model.skillSteps).font(.system(size: 13, design: .monospaced)).frame(minHeight: 190)
                    .scrollContentBackground(.hidden).padding(8)
                    .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.38)))
                    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.white.opacity(0.09)))
                Toggle("Enabled", isOn: $model.skillEnabled).toggleStyle(.switch).foregroundStyle(Obsidian.text)
                HStack {
                    if model.skillID != nil { GhostButton(title: "Delete", icon: "trash", danger: true) { Task { await model.deleteSkill() } } }
                    Spacer()
                    PrimaryButton(title: "Save skill", icon: "checkmark") { Task { await model.saveSkill() } }
                }
            }
        }
    }
}

// MARK: - Connectors

struct ConnectorsPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(model.connectors) { c in
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(c.enabled ? AnyShapeStyle(LinearGradient(colors: [Fire.ember.opacity(0.28), Fire.deep.opacity(0.2)], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(0.04)))
                        Image(systemName: icon(c.id)).font(.system(size: 15, weight: .medium))
                            .foregroundStyle(c.enabled ? AnyShapeStyle(Obsidian.metal) : AnyShapeStyle(Obsidian.faint))
                    }
                    .frame(width: 38, height: 38)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(c.enabled ? AnyShapeStyle(Obsidian.accentRim) : AnyShapeStyle(Obsidian.rim), lineWidth: 1))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Obsidian.text)
                        Text(c.description).font(.system(size: 11.5)).foregroundStyle(Obsidian.muted).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 5) {
                            if c.onMac { Badge(text: "MAC APP") }
                            if let status = c.status { Badge(text: status.uppercased(), color: Obsidian.warn) }
                        }
                    }
                    Spacer(minLength: 6)
                    Toggle("", isOn: Binding(get: { c.enabled }, set: { on in Task { await model.setConnector(c, on) } }))
                        .toggleStyle(.switch).labelsHidden().controlSize(.small)
                }
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(c.enabled ? 0.035 : 0.018)))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Obsidian.rim, lineWidth: 1))
            }
        }
        McpSection(model: model)
    }

    private func icon(_ id: String) -> String {
        switch id {
        case "web": return "globe"
        case "calendar": return "calendar"
        case "reminders": return "checklist"
        case "messages": return "message"
        case "apple_notes": return "note.text"
        case "apps": return "macwindow"
        case "files": return "folder"
        case "shortcuts": return "square.stack.3d.up"
        case "screen": return "cursorarrow.motionlines"
        case "email": return "envelope"
        default: return "doc.text"
        }
    }
}

// MARK: - Third-party connectors (MCP)

struct McpSection: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        Card(title: "Add a connector", subtitle: "Connect services through MCP, the open standard for AI connectors. Reading runs freely; anything that creates, sends or changes something asks you first, and what comes back is screened by the Privacy Shield. Only add connectors you trust: each one runs with your permissions.", label: "Third-party") {
            HStack(spacing: 8) {
                ForEach(model.presets) { p in GhostButton(title: p.name, icon: "plus") { model.pickPreset(p.preset) } }
                GhostButton(title: "Custom URL", icon: "link") { model.pickPreset("custom-http") }
                GhostButton(title: "Custom command", icon: "terminal") { model.pickPreset("custom-command") }
            }
            if model.addingConnector {
                VStack(alignment: .leading, spacing: 10) {
                    Rectangle().fill(Obsidian.hairline).frame(height: 1)
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            FieldLabel(text: "Name")
                            TextField("Linear", text: $model.draftName).insetField().frame(width: 190)
                        }
                        if model.draftTransport == "http" {
                            VStack(alignment: .leading, spacing: 6) {
                                FieldLabel(text: "Server URL")
                                TextField("https://example.com/mcp", text: $model.draftURL).insetField(mono: true)
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 6) {
                                FieldLabel(text: "Command")
                                TextField("npx", text: $model.draftCommand).insetField(mono: true).frame(width: 110)
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                FieldLabel(text: "Arguments")
                                TextField("-y @org/mcp-server", text: $model.draftArgs).insetField(mono: true)
                            }
                        }
                    }
                    HStack(alignment: .top, spacing: 14) {
                        if model.draftTransport == "stdio" {
                            VStack(alignment: .leading, spacing: 6) {
                                FieldLabel(text: "Token variable")
                                TextField("API_TOKEN", text: $model.draftTokenEnv).insetField(mono: true).frame(width: 190)
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            FieldLabel(text: model.draftTransport == "http" ? "Access token (sent as Bearer)" : "Token")
                            SecureField("Optional; kept in your Keychain", text: $model.draftToken).insetField(mono: true)
                        }
                    }
                    if !model.tokenHelp.isEmpty {
                        Text(model.tokenHelp).font(.system(size: 11.5)).foregroundStyle(Obsidian.muted)
                    }
                    HStack {
                        Spacer()
                        GhostButton(title: "Cancel") { model.addingConnector = false }
                        PrimaryButton(title: "Connect", icon: "bolt.fill") { Task { await model.addConnector() } }
                    }
                }
            }
        }
        ForEach(model.mcp) { c in
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Fire.ember.opacity(c.status == "connected" ? 0.25 : 0.06))
                        Image(systemName: "puzzlepiece.extension.fill").font(.system(size: 14)).foregroundStyle(c.status == "connected" ? AnyShapeStyle(Obsidian.metal) : AnyShapeStyle(Obsidian.faint))
                    }
                    .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(c.name).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Obsidian.text)
                            Badge(text: c.status.uppercased(), color: c.status == "connected" ? Obsidian.good : c.status == "error" ? Obsidian.bad : Obsidian.muted)
                            Badge(text: c.transport == "http" ? "REMOTE" : "ON THIS MAC")
                        }
                        Text(c.status == "connected" ? "\(c.tools.count) tools · \(c.tools.filter { !$0.asks }.count) read freely, \(c.tools.filter { $0.asks }.count) ask first" : (c.error ?? ""))
                            .font(.system(size: 11.5)).foregroundStyle(c.status == "error" ? Obsidian.bad : Obsidian.muted).lineLimit(2)
                    }
                    Spacer()
                    if c.status == "error" { GhostButton(title: "Retry", icon: "arrow.clockwise") { Task { await model.reconnectMcp(c) } } }
                    Button { Task { await model.removeMcp(c) } } label: { Image(systemName: "trash") }.buttonStyle(.plain).foregroundStyle(Obsidian.muted).help("Remove")
                    Toggle("", isOn: Binding(get: { c.enabled }, set: { on in Task { await model.setMcp(c, on) } })).toggleStyle(.switch).labelsHidden().controlSize(.small)
                }
                if c.status == "connected" && !c.tools.isEmpty {
                    FlowList(items: c.tools.map(\.title)) { title in
                        let asks = c.tools.first { $0.title == title }?.asks ?? true
                        HStack(spacing: 5) {
                            Image(systemName: asks ? "hand.raised.fill" : "eye").font(.system(size: 9))
                            Text(title).font(.system(size: 11, design: .monospaced))
                        }
                        .foregroundStyle(asks ? Fire.amber : Obsidian.muted)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(Color.white.opacity(0.04)))
                    }
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.03)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Obsidian.rim, lineWidth: 1))
        }
    }
}

// MARK: - Backups

struct BackupsPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        if !model.backupReady {
            Card(title: "Turn on backups", subtitle: "Choose a passphrase. Backups are locked with it, so nobody, not Apple, not anyone with your iCloud, can open them. Write it down: if it's lost, the backups can't be opened by anyone, including you.", label: "Set up") {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        FieldLabel(text: "Passphrase (12+ characters)")
                        SecureField("A short sentence works well", text: $model.pass1).insetField()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        FieldLabel(text: "Again")
                        SecureField("Repeat it", text: $model.pass2).insetField()
                    }
                }
                HStack {
                    Spacer()
                    PrimaryButton(title: "Turn on and back up now", icon: "lock.shield") { Task { await model.setupBackups() } }
                }
            }
        } else {
            Card(label: "Status") {
                HStack(spacing: 14) {
                    Image(systemName: model.backupError == nil ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                        .font(.system(size: 26)).foregroundStyle(model.backupError == nil ? AnyShapeStyle(Obsidian.metal) : AnyShapeStyle(Obsidian.bad))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.lastBackup.map { "Last backup \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened))" } ?? "No backup yet")
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(Obsidian.text)
                        Text(model.backupError.map { "Last attempt failed: \($0)" } ?? "Encrypted on this Mac before it's saved. Keeps the newest 14.")
                            .font(.system(size: 12)).foregroundStyle(model.backupError == nil ? Obsidian.muted : Obsidian.bad)
                    }
                    Spacer()
                    GhostButton(title: "Show", icon: "folder") { model.revealBackups() }
                    PrimaryButton(title: "Back up now", icon: "arrow.up.doc") { Task { await model.backupNow() } }
                }
            }
            Card(title: "Where and when", subtitle: "iCloud Drive keeps a copy off this Mac. The files are useless without your passphrase.", label: "Settings") {
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Folder")
                    TextField("", text: $model.backupDir).insetField(mono: true)
                }
                Toggle("Back up automatically every day", isOn: $model.backupNightly).toggleStyle(.switch).foregroundStyle(Obsidian.text)
                HStack { Spacer(); PrimaryButton(title: "Save") { Task { await model.saveBackupSettings() } } }
            }
            Card(title: "Restoring", subtitle: "On this Mac or a new one: install Phoenix, stop the core (npm run phoenix -- autostart off), then run npm run phoenix -- backup restore <file> and enter your passphrase. Your current data is kept aside, never deleted.", label: "If you need it") {
                EmptyView()
            }
        }
    }
}

// MARK: - API keys

struct KeysPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        if !model.usage.isEmpty {
            Card(title: "What Phoenix costs", subtitle: "Estimated from Phoenix's own token counts at list prices; your Anthropic bill is the source of truth. Cached input costs about a tenth.", label: "Usage") {
                HStack(spacing: 12) {
                    ForEach(model.usage, id: \.0) { u in
                        VStack(alignment: .leading, spacing: 4) {
                            HUDLabel(text: u.0, color: Obsidian.muted)
                            Text(String(format: "$%.2f", u.1)).font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(Obsidian.text)
                            Text("\(u.2) model calls · \(Int((u.3 * 100).rounded()))% cached").font(.system(size: 11.5)).foregroundStyle(Obsidian.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.25)))
                    }
                }
            }
        }
        ForEach(model.keys) { k in
            Card(title: k.label, subtitle: subtitle(k), label: k.name == "anthropic" ? "Required" : "Optional") {
                HStack(spacing: 10) {
                    Image(systemName: k.saved ? "checkmark.seal.fill" : "exclamationmark.circle")
                        .foregroundStyle(k.saved ? Obsidian.good : Obsidian.warn)
                    Text(k.saved ? (k.hint ?? "Saved") : "Not set").font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Obsidian.text)
                    if k.saved { Badge(text: k.source == "environment" ? "ENVIRONMENT" : "KEYCHAIN", color: Obsidian.good) }
                    Spacer()
                    if k.saved && k.name == "anthropic" { GhostButton(title: "Test", icon: "bolt") { Task { await model.testKey() } } }
                    if k.saved && k.source == "keychain" { GhostButton(title: "Remove", danger: true) { Task { await model.removeKey(k) } } }
                }
                HStack(spacing: 10) {
                    SecureField(k.saved ? "Paste a new key to replace it" : "Paste the key", text: Binding(
                        get: { model.keyInputs[k.name] ?? "" }, set: { model.keyInputs[k.name] = $0 }))
                        .insetField(mono: true)
                        .onSubmit { Task { await model.saveKey(k.name) } }
                    PrimaryButton(title: k.saved ? "Replace" : "Save") { Task { await model.saveKey(k.name) } }
                }
            }
        }
    }

    private func subtitle(_ k: KeyRow) -> String {
        switch k.name {
        case "anthropic": return "\(Persona.name) thinks with Claude. Create a key at console.anthropic.com › API Keys."
        case "elevenlabs": return "Only for the ElevenLabs cloud voice. The default Kokoro voice runs on this Mac."
        default: return ""
        }
    }
}

// MARK: - History

struct HistoryPane: View {
    @ObservedObject var model: ControlCenterModel

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Obsidian.muted)
                    TextField("Search conversations", text: $model.historyQuery).textFieldStyle(.plain).font(.system(size: 12.5)).foregroundStyle(Obsidian.text)
                }
                .padding(.horizontal, 11).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.35)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.09)))
                if model.filteredHistory.isEmpty {
                    Text("No conversations yet.").font(.system(size: 12)).foregroundStyle(Obsidian.muted).padding(.top, 8)
                }
                ForEach(model.filteredHistory) { h in
                    let selected = model.historyID == h.id
                    Button { Task { await model.openHistory(h) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(Date(timeIntervalSince1970: h.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))
                                    .font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(selected ? Fire.gold : Obsidian.faint)
                                Spacer()
                                Text("\(h.turns)×").font(.system(size: 10, design: .monospaced)).foregroundStyle(Obsidian.faint)
                            }
                            Text(h.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Obsidian.text).lineLimit(2)
                            if !h.preview.isEmpty { Text(h.preview).font(.system(size: 11.5)).foregroundStyle(Obsidian.muted).lineLimit(2) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? Fire.ember.opacity(0.12) : Color.white.opacity(0.028)))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? AnyShapeStyle(Obsidian.accentRim) : AnyShapeStyle(Obsidian.rim), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: 290)
            VStack(alignment: .leading, spacing: 12) {
                if model.historyID == nil {
                    VStack(spacing: 12) {
                        PhoenixLogo(size: 44).opacity(0.6)
                        Text("Pick a conversation to read it.").font(.system(size: 13)).foregroundStyle(Obsidian.muted)
                    }
                    .frame(maxWidth: .infinity).padding(.top, 70)
                } else {
                    HStack(spacing: 8) {
                        HUDLabel(text: "Transcript")
                        Spacer()
                        GhostButton(title: "Copy", icon: "doc.on.doc") { model.copyTranscript() }
                        GhostButton(title: "Delete", icon: "trash", danger: true) { Task { await model.deleteHistory() } }
                    }
                    ForEach(model.transcript) { line in TranscriptBubble(line: line) }
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

struct TranscriptBubble: View {
    let line: TranscriptLine

    var body: some View {
        switch line.role {
        case "action":
            HStack(spacing: 7) {
                Image(systemName: "bolt.fill").font(.system(size: 9))
                Text(line.text.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.2)
            }
            .foregroundStyle(Fire.amber).padding(.leading, 8)
        case "you":
            HStack {
                Spacer(minLength: 70)
                Text(line.text).font(.system(size: 13)).foregroundStyle(Obsidian.text).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.07)))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Obsidian.rim, lineWidth: 1))
            }
        default:
            HStack(alignment: .top, spacing: 11) {
                PhoenixLogo(size: 18).padding(.top, 1)
                Text(line.text).font(.system(size: 13)).foregroundStyle(Obsidian.text).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(2.5)
                Spacer(minLength: 40)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [Fire.ember.opacity(0.09), Fire.ember.opacity(0.03)], startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Obsidian.accentRim.opacity(0.5), lineWidth: 1))
        }
    }
}

// MARK: - Offscreen preview (design check)

/// `Phoenix --args -renderPreview /path/to/dir` renders every Control Center tab with sample
/// data to PNGs (no screen recording needed), then quits. Used to check the design.
@MainActor
enum ControlCenterPreview {
    static func render(to dir: String, state: AppState) {
        let model = ControlCenterModel(core: CoreClient(), state: state)
        model.connectors = [
            ConnectorRow(id: "web", name: "Web search", description: "Current information: weather, news, prices.", enabled: true, onMac: false, status: nil),
            ConnectorRow(id: "calendar", name: "Calendar", description: "Read your calendar and add events.", enabled: true, onMac: true, status: nil),
            ConnectorRow(id: "messages", name: "Contacts & iMessage", description: "Look people up and send iMessages (always with your OK).", enabled: true, onMac: true, status: nil),
            ConnectorRow(id: "screen", name: "Screen control", description: "Operate allowed apps on screen, incl. iPhone Mirroring.", enabled: true, onMac: true, status: nil),
            ConnectorRow(id: "email", name: "Email", description: "Drafts go to a local outbox for now.", enabled: false, onMac: false, status: "Gmail sign-in on hold"),
            ConnectorRow(id: "shortcuts", name: "Shortcuts", description: "Run your Shortcuts (always with your OK).", enabled: true, onMac: false, status: nil),
        ]
        model.keys = [KeyRow(name: "anthropic", label: "Anthropic API key", saved: true, source: "keychain", hint: "sk-ant-api… (108 characters)"),
                      KeyRow(name: "elevenlabs", label: "ElevenLabs API key", saved: false, source: nil, hint: nil)]
        let now = Date().timeIntervalSince1970 * 1000
        model.memories = [
            MemoryRow(id: 3, kind: "profile", subject: nil, text: "Lives in Hyderabad; works across product, AI and IoT.", createdAt: now),
            MemoryRow(id: 7, kind: "person", subject: "Ankit", text: "Colleague; prefers short WhatsApp messages.", createdAt: now),
            MemoryRow(id: 9, kind: "project", subject: "Aranya Retreat", text: "Premium farm plots near Sadashivpet; needs better lead generation.", createdAt: now),
            MemoryRow(id: 12, kind: "style", subject: nil, text: "Emails: get to the point, sign off with 'Best Regards,'.", createdAt: now),
        ]
        model.skills = [SkillRow(id: 1, name: "My usual Swiggy order", description: "Reorder my usual biryani on Swiggy", steps: "1. Open iPhone Mirroring → Swiggy\n2. Reorder from Meghana Foods\n3. Stop before payment", enabled: true)]
        model.selectSkill(model.skills.first)
        model.screenApps = ["WhatsApp", "iPhone Mirroring", "Safari", "Notes"]
        model.backupReady = true
        model.backupDir = "~/Library/Mobile Documents/com~apple~CloudDocs/Phoenix Backups"
        model.lastBackup = now
        model.mcp = [McpRow(id: "github", name: "GitHub", transport: "http", enabled: true, status: "connected", error: nil,
                            tools: [McpToolRow(name: "a", title: "search_issues", asks: false), McpToolRow(name: "b", title: "list_notifications", asks: false),
                                    McpToolRow(name: "c", title: "create_issue", asks: true), McpToolRow(name: "d", title: "add_comment", asks: true)])]
        model.presets = [McpPreset(preset: "github", name: "GitHub", transport: "http", url: nil, command: nil, args: [], tokenEnv: nil, tokenHelp: ""),
                         McpPreset(preset: "notion", name: "Notion", transport: "stdio", url: nil, command: nil, args: [], tokenEnv: nil, tokenHelp: "")]
        model.history = [HistoryRow(id: "h1", title: "WhatsApp Ankit that I'm running late", preview: "Sent it to Ankit.", updatedAt: now, turns: 2),
                         HistoryRow(id: "h2", title: "What does my day look like?", preview: "Two meetings and the gym at 7.", updatedAt: now - 86_400_000, turns: 1)]
        model.historyID = "h1"
        model.transcript = [TranscriptLine(id: 0, role: "you", text: "WhatsApp Ankit that I'm running 10 minutes late"),
                            TranscriptLine(id: 1, role: "action", text: "Used an app on screen"),
                            TranscriptLine(id: 2, role: "phoenix", text: "Sent \"running 10 mins late\" to Ankit on WhatsApp.")]
        let host = NSHostingView(rootView: ControlCenterView(model: model, state: state))
        let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 1080, height: 720), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.orderFront(nil)
        let sections = ControlCenterModel.Section.allCases
        func shoot(_ i: Int) {
            guard i < sections.count else { NSApp.terminate(nil); return }
            model.section = sections[i]
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                host.layoutSubtreeIfNeeded()
                if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                    host.cacheDisplay(in: host.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(dir)/cc-\(sections[i].rawValue.replacingOccurrences(of: " ", with: "-")).png"))
                }
                shoot(i + 1)
            }
        }
        shoot(0)
    }
}
