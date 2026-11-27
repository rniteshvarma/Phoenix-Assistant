import Foundation
import SwiftUI

enum Phase: Equatable {
    case idle, listening, thinking, working, waitingForYou, done, failed, offline

    var label: String {
        switch self {
        case .idle: return "READY"
        case .listening: return "LISTENING"
        case .thinking: return "THINKING"
        case .working: return "WORKING"
        case .waitingForYou: return "NEEDS YOUR OK"
        case .done: return "DONE"
        case .failed: return "STOPPED"
        case .offline: return "CORE OFFLINE"
        }
    }
}

struct Step: Identifiable, Equatable {
    enum State { case running, ok, failed, blocked }
    let id = UUID()
    var text: String
    var state: State
}

struct ApprovalCard: Identifiable, Equatable {
    let id: String
    let tool: String
    let tierLabel: String
    let summary: String
    let payload: String
    let payloadHash: String
    /// 1 = first approval; 2 = "Are you sure?" (protected data would leave the Mac).
    var stage: Int = 1
    /// Protected data in this action, e.g. ["PAN", "email address"].
    var protectedKinds: [String] = []
}

/// Everything the Summon Bar shows. Mutated only on the main thread.
@MainActor
final class AppState: ObservableObject {
    @Published var phase: Phase = .offline
    @Published var connected = false
    @Published var channel: String = "voice"
    @Published var userText = ""
    @Published var replyText = ""
    @Published var steps: [Step] = []
    @Published var approval: ApprovalCard?
    @Published var statusLine = ""
    @Published var levels: [CGFloat] = Array(repeating: 0.05, count: 28)
    @Published var wakeEnabled = UserDefaults.standard.object(forKey: "wakeEnabled") as? Bool ?? true {
        didSet { UserDefaults.standard.set(wakeEnabled, forKey: "wakeEnabled") }
    }
    @Published var voiceReady = false
    /// Phoenix is talking right now (shows the Stop button).
    @Published var speaking = false
    /// Time from the end of your request to Phoenix's first spoken word, e.g. "1.9 s".
    @Published var latencyText = ""
    @Published var latencyGood = true
    /// When Phoenix was last summoned; drives the "rise" animation.
    @Published var riseStartedAt: Date = .distantPast
    /// Centre of the listening view's AI core, measured in the panel (top-left origin).
    var coreCenterInPanel: CGPoint?
    /// Measured height of the reply text, so the panel can cap and scroll it.
    @Published var replyHeight: CGFloat = 0
    @Published var typing = false
    /// Text being typed in the Summon Bar.
    @Published var draft = ""
    /// "Change…" on an approval card: feedback being typed.
    @Published var changingApproval = false
    @Published var approvalFeedback = ""

    var busy: Bool { [.thinking, .working, .waitingForYou].contains(phase) }

    func pushLevel(_ level: Float) {
        levels.removeFirst()
        levels.append(CGFloat(max(0.05, min(1, level))))
    }
}
