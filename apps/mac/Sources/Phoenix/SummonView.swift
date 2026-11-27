import SwiftUI

/// "Ember" palette from the plan (§6.1).
enum Ember {
    static let panel = Color(red: 0.078, green: 0.082, blue: 0.102).opacity(0.95)
    static let border = Color(red: 0.165, green: 0.172, blue: 0.2)
    static let ember = Color(red: 1.0, green: 0.416, blue: 0.169)
    static let amber = Color(red: 1.0, green: 0.71, blue: 0.278)
    static let warn = Color(red: 1.0, green: 0.784, blue: 0.341)
    static let green = Color(red: 0.357, green: 0.839, blue: 0.604)
    static let red = Color(red: 1.0, green: 0.302, blue: 0.369)
    static let text = Color(white: 0.93)
    static let dim = Color(white: 0.55)
    static let flame = LinearGradient(colors: [ember, amber], startPoint: .bottom, endPoint: .top)
}

struct SummonView: View {
    @ObservedObject var state: AppState
    let controller: PhoenixController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if !state.userText.isEmpty {
                Text(state.userText)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Ember.text)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            } else if state.phase == .listening {
                HStack(spacing: 18) {
                    CoreOrb(size: 78, active: true, riseStartedAt: state.riseStartedAt)
                        .background(GeometryReader { g in
                            Color.clear.preference(key: CoreCenterKey.self,
                                                   value: CGPoint(x: g.frame(in: .global).midX, y: g.frame(in: .global).midY))
                        })
                        .onPreferenceChange(CoreCenterKey.self) { center in
                            DispatchQueue.main.async { state.coreCenterInPanel = center }
                        }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("PHOENIX HAS RISEN")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .tracking(2.2)
                            .foregroundStyle(Fire.body)
                        Text("I'm listening…")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Ember.text)
                    }
                }
                .transition(.opacity)
            }
            if state.typing {
                typingField
            }
            if !state.replyText.isEmpty || state.phase == .thinking {
                reply
            }
            if !state.steps.isEmpty {
                StepChips(steps: Array(state.steps.suffix(4)))
            }
            if let card = state.approval {
                ApprovalCardView(card: card, controller: controller, state: state)
            }
            if !state.statusLine.isEmpty {
                Text(state.statusLine)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Ember.warn)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
        .frame(width: 680, alignment: .leading)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 16).fill(Color(red: 0.03, green: 0.034, blue: 0.045).opacity(0.86))
                DotGrid()
                LinearGradient(colors: [Color.white.opacity(0.05), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.25))
                EmberField(intensity: isActive ? 0.22 : 0.06, riseStartedAt: state.riseStartedAt, count: 26)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16))
        )
        .overlay(TechBorder(active: isActive, cornerRadius: 16))
        .environment(\.colorScheme, .dark)
        .onReceive(NotificationCenter.default.publisher(for: .phoenixEscape)) { _ in controller.escape() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 11))
                .foregroundStyle(Ember.dim.opacity(0.6))
                .help("Drag to move")
            StatusChip(phase: state.phase, speaking: state.speaking)
            if !state.latencyText.isEmpty {
                Label(state.latencyText, systemImage: "bolt.fill")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(state.latencyGood ? Ember.green : Ember.warn)
                    .help("Time from when you stopped talking to Phoenix's first word (target under 2.5 s)")
            }
            Text(headerLabel)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(1.4)
                .foregroundStyle(Ember.dim)
            if state.phase == .listening {
                Waveform(levels: state.levels)
            } else {
                Rectangle()
                    .fill(LinearGradient(colors: [Color.white.opacity(0.10), .clear], startPoint: .leading, endPoint: .trailing))
                    .frame(height: 1)
            }
            if state.speaking {
                Button(action: { controller.stopSpeaking() }) {
                    Label("Stop", systemImage: "stop.fill")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(Capsule().fill(Ember.ember.opacity(0.18)))
                        .overlay(Capsule().stroke(Ember.ember.opacity(0.7), lineWidth: 1))
                        .foregroundStyle(Ember.ember)
                }
                .buttonStyle(.plain)
                .help("Stop talking (Esc or ⌥Space)")
            }
            Button(action: { controller.beginTyping() }) {
                Image(systemName: "keyboard").foregroundStyle(Ember.dim)
            }
            .buttonStyle(.plain)
            .help("Type instead")
            Button(action: { controller.stop() }) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(Ember.dim)
            }
            .buttonStyle(.plain)
            .help("Stop (Esc)")
        }
        .background(DragHandle())
    }

    private var isActive: Bool {
        [.listening, .thinking, .working, .waitingForYou].contains(state.phase) || state.speaking
    }

    private var headerLabel: String {
        state.channel == "voice" ? "VOICE" : "TEXT"
    }

    private var typingField: some View {
        TextField("Ask Phoenix…", text: $state.draft)
            .textFieldStyle(.plain)
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(Ember.text)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
            .onSubmit {
                let text = state.draft
                state.draft = ""
                controller.submit(text, channel: "text")
            }
    }

    private var reply: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PHOENIX")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .tracking(1.6)
                .foregroundStyle(Fire.body)
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .lastTextBaseline, spacing: 2) {
                            Text(state.replyText)
                                .font(.system(size: 13.5, design: .monospaced))
                                .foregroundStyle(Ember.text)
                                .lineSpacing(3)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if state.phase == .thinking || state.phase == .working {
                                BlinkingCursor()
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Color.clear.frame(height: 1).id("replyEnd")
                    }
                    .background(GeometryReader { g in
                        Color.clear.preference(key: ReplyHeightKey.self, value: g.size.height)
                    })
                }
                .frame(height: min(max(state.replyHeight, 18), Self.maxReplyHeight))
                .onPreferenceChange(ReplyHeightKey.self) { height in
                    DispatchQueue.main.async { state.replyHeight = height }
                }
                .onChange(of: state.replyText) {
                    proxy.scrollTo("replyEnd", anchor: .bottom)
                }
            }
        }
        .padding(.leading, 2)
    }

    /// Long replies scroll inside the panel instead of pushing it off screen.
    static var maxReplyHeight: CGFloat {
        let screen = NSScreen.main?.visibleFrame.height ?? 800
        return max(160, min(380, screen * 0.42))
    }
}

struct FlameBadge: View {
    let phase: Phase

    var body: some View {
        TimelineView(.animation) { context in
            let active = [.listening, .thinking, .working, .waitingForYou].contains(phase)
            let speed = phase == .thinking ? 1.4 : 3.2
            let wave = active ? (sin(context.date.timeIntervalSinceReferenceDate * speed) + 1) / 2 : 1
            ZStack {
                RoundedRectangle(cornerRadius: 7).stroke(Ember.border, lineWidth: 1).frame(width: 30, height: 30)
                Image(systemName: phase == .offline ? "flame" : "flame.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(phase == .offline ? AnyShapeStyle(Ember.dim) : AnyShapeStyle(Ember.flame))
                    .scaleEffect(active ? 0.94 + 0.16 * wave : 1)
                    .opacity(phase == .waitingForYou ? 0.55 + 0.45 * wave : 1)
            }
        }
    }
}

struct Waveform: View {
    let levels: [CGFloat]

    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(Fire.body)
                    .frame(width: 2.5, height: max(3, level * 22))
                    .shadow(color: Fire.ember.opacity(0.6), radius: 2)
            }
        }
        .frame(height: 24)
        .animation(.linear(duration: 0.08), value: levels)
    }
}

struct BlinkingCursor: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            Rectangle()
                .fill(Fire.body)
                .frame(width: 8, height: 15)
                .opacity(Int(context.date.timeIntervalSinceReferenceDate * 2) % 2 == 0 ? 1 : 0.15)
        }
    }
}

struct StepChips: View {
    let steps: [Step]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(steps) { step in
                HStack(spacing: 7) {
                    Image(systemName: icon(step.state))
                        .foregroundStyle(color(step.state))
                        .font(.system(size: 11, weight: .bold))
                    Text(step.text)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Ember.dim)
                        .lineLimit(1)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Ember.border, lineWidth: 1))
            }
        }
    }

    private func icon(_ s: Step.State) -> String {
        switch s {
        case .running: return "arrow.triangle.2.circlepath"
        case .ok: return "checkmark"
        case .failed: return "xmark"
        case .blocked: return "nosign"
        }
    }

    private func color(_ s: Step.State) -> Color {
        switch s {
        case .running: return Ember.amber
        case .ok: return Ember.green
        case .failed, .blocked: return Ember.red
        }
    }
}

struct ApprovalCardView: View {
    let card: ApprovalCard
    let controller: PhoenixController
    @ObservedObject var state: AppState

    var body: some View {
        if card.stage == 2 { areYouSure } else { firstApproval }
    }

    /// Second confirmation before protected data leaves the Mac.
    private var areYouSure: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield.fill").foregroundStyle(Ember.red)
                Text("ARE YOU SURE?")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .tracking(1.6)
                    .foregroundStyle(Ember.red)
                Text("SECOND CONFIRMATION")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Ember.dim)
                Spacer()
            }
            Text("This sends your \(card.protectedKinds.joined(separator: ", ")) off this Mac.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Ember.text)
            Text(card.summary)
                .font(.system(size: 12.5))
                .foregroundStyle(Ember.text.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button(action: { controller.approve() }) {
                    Label("Yes, I'm sure", systemImage: "touchid")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Ember.red))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                Button("No, don't share") { controller.reject() }
                    .buttonStyle(.plain)
                    .foregroundStyle(Ember.text)
                Spacer()
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.red.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ember.red.opacity(0.7), lineWidth: 1))
    }

    private var firstApproval: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("◆ NEEDS YOUR OK")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .tracking(1.4)
                    .foregroundStyle(Ember.warn)
                Text(card.tierLabel.uppercased())
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Ember.dim)
                Spacer()
            }
            Text(card.summary)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Ember.text)
                .fixedSize(horizontal: false, vertical: true)
            if !card.protectedKinds.isEmpty {
                Label("Contains protected data: \(card.protectedKinds.joined(separator: ", ")) — you'll be asked twice",
                      systemImage: "lock.fill")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(Ember.red)
            }
            ScrollView {
                Text(card.payload)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Ember.text.opacity(0.85))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 170)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
            Text("payload \(String(card.payloadHash.prefix(12)))… · approving uses Touch ID")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Ember.dim)
            if state.changingApproval {
                HStack {
                    TextField("What should Phoenix change?", text: $state.approvalFeedback)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(sendChange)
                    Button("Send", action: sendChange)
                }
            } else {
                HStack(spacing: 10) {
                    Button(action: { controller.approve() }) {
                        Label("Approve", systemImage: "touchid")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Ember.ember))
                            .foregroundStyle(.black)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: .command)
                    Button("Change…") { state.changingApproval = true }
                        .buttonStyle(.plain)
                        .foregroundStyle(Ember.amber)
                    Button("Reject") { controller.reject() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Ember.dim)
                    Spacer()
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.warn.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ember.warn.opacity(0.55), lineWidth: 1))
    }

    private func sendChange() {
        controller.reject(feedback: state.approvalFeedback)
        state.approvalFeedback = ""
        state.changingApproval = false
    }
}

/// Where the listening core sits inside the panel, so the summon effect can centre on it.
struct CoreCenterKey: PreferenceKey {
    static var defaultValue: CGPoint? = nil
    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) { value = nextValue() ?? value }
}
