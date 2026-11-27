import AppKit
import Foundation

/// Glue between the Summon Bar, voice, native skills and the Phoenix core.
@MainActor
final class PhoenixController {
    let state = AppState()
    private let core = CoreClient()
    private let speaker = Speaker()
    private let listener = VoiceListener()
    private let calendar = CalendarBridge()
    private let summonFX = SummonOverlay()
    let stats = PhoenixStats()
    /// When you stopped talking, for the request whose first spoken word we're waiting on.
    private var measureFrom: Date?
    /// The panel was opened by "Phoenix, rise" (an empty request after it counts as a false wake-up).
    private var wokeByPhrase = false
    private var listeningClock: Timer?
    private(set) var panel: SummonPanel!

    private var requestId: String?
    private var requestChannel = "text"
    private var turnHadDeltas = false
    private var needsBreak = false
    private var hideWork: DispatchWorkItem?

    func start() {
        panel = SummonPanel(rootView: SummonView(state: state, controller: self))

        core.onConnectionChange = { [weak self] up in
            Task { @MainActor in self?.connectionChanged(up) }
        }
        core.onMessage = { [weak self] message in
            Task { @MainActor in self?.handle(message) }
        }
        core.start()

        // Count time spent listening for "Phoenix, rise" (for false wake-ups per hour).
        listeningClock = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.state.wakeEnabled, self.state.voiceReady else { return }
                self.stats.addListening(30)
            }
        }

        speaker.onStart = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                // Keep listening for "Phoenix, stop" while speaking (only if voice listening is on).
                if self.state.wakeEnabled && self.state.voiceReady { self.listener.listenForInterrupt() }
                else { self.listener.pause() }
            }
        }
        speaker.onIdle = { [weak self] in
            Task { @MainActor in self?.speakingFinished() }
        }
        speaker.onAudioStart = { [weak self] in
            Task { @MainActor in self?.firstAudio() }
        }
        speaker.onSpeakingChange = { [weak self] speaking in
            Task { @MainActor in self?.state.speaking = speaking }
        }

        listener.onWake = { [weak self] in
            Task { @MainActor in self?.heardWake() }
        }
        listener.onPartial = { [weak self] text in
            Task { @MainActor in self?.state.userText = text }
        }
        listener.onCommand = { [weak self] text in
            Task { @MainActor in self?.submit(text, channel: "voice") }
        }
        listener.onCommandEmpty = { [weak self] in
            Task { @MainActor in self?.listenTimedOut() }
        }
        listener.onInterrupt = { [weak self] heard in
            Task { @MainActor in self?.heardStop(heard) }
        }
        listener.onLevel = { [weak self] level in
            Task { @MainActor in self?.state.pushLevel(level) }
        }

        Task { @MainActor in
            if let problem = await listener.prepare() {
                state.statusLine = problem
                state.voiceReady = false
            } else {
                state.voiceReady = true
                if state.wakeEnabled { listener.startWake() }
            }
        }
    }

    // MARK: - User actions

    func hotKeyPressed() {
        // While Phoenix is talking, the hotkey just silences it.
        if speaker.isSpeaking {
            stopSpeaking()
            return
        }
        if listener.mode == .command {
            listener.finishCommand()
            return
        }
        if state.busy {
            show()
            return
        }
        resetForNewRequest()
        state.channel = "voice"
        if state.voiceReady {
            state.phase = .listening
            listener.startCommand()   // listening starts at once; the flight is only visual
            summon()
        } else {
            rise()
            show()
            beginTyping()
        }
    }

    func beginTyping() {
        if !panel.isVisible { rise() }
        if listener.mode == .command { listener.pause(); listener.resume() }
        state.typing = true
        state.channel = "text"
        show(focus: true)
    }

    func submit(_ raw: String, channel: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !state.busy else { return }
        resetForNewRequest()
        state.userText = text
        state.channel = channel
        state.typing = false
        requestChannel = channel
        wokeByPhrase = false
        if channel == "voice" {
            // Count from when you stopped talking (if recent), else from now.
            let spoke = listener.lastSpeechAt
            measureFrom = Date().timeIntervalSince(spoke) < 10 ? spoke : Date()
        } else {
            measureFrom = nil
        }
        show()
        guard state.connected else {
            state.phase = .offline
            state.replyText = "The Phoenix core isn't running. Choose “Start Phoenix core” in the menu bar, or run once in Terminal:  npm run phoenix -- autostart on"
            if channel == "voice" { speaker.say("The Phoenix core isn't running.") }
            return
        }
        let id = UUID().uuidString
        requestId = id
        state.phase = .thinking
        var message: [String: Any] = ["type": "request", "id": id, "text": text, "channel": channel]
        if pendingNewSession {
            message["newSession"] = true
            pendingNewSession = false
        }
        core.send(message)
    }

    func approve() {
        guard let card = state.approval else { return }
        Task { @MainActor in
            let reason = card.stage == 2
                ? "confirm again: share your \(card.protectedKinds.joined(separator: ", ")) — \(card.summary)"
                : "approve: \(card.summary)"
            let ok = await Auth.confirm(reason)
            guard state.approval?.id == card.id else { return }
            if ok {
                core.send(["type": "approval", "proposalId": card.id, "decision": "approve"])
                state.approval = nil
                state.phase = .working
            } else {
                state.statusLine = "Not approved: Touch ID / password was cancelled."
            }
        }
    }

    func reject(feedback: String? = nil) {
        guard let card = state.approval else { return }
        var message: [String: Any] = ["type": "approval", "proposalId": card.id, "decision": "reject"]
        if let feedback, !feedback.isEmpty { message["feedback"] = feedback }
        core.send(message)
        state.approval = nil
        state.phase = .working
    }

    /// Silence Phoenix but keep the panel (and any running task) as it is.
    func stopSpeaking() {
        speaker.stop()
        state.speaking = false
        listener.resume()
    }

    /// Esc: first press silences Phoenix if it's talking; otherwise stop and hide.
    func escape() {
        if speaker.isSpeaking { stopSpeaking() } else { stop() }
    }

    /// Stop everything: silence, cancel the running task, hide.
    func stop() {
        speaker.stop()
        if listener.mode == .command { listener.pause() }
        if state.busy { core.send(["type": "cancel"]) }
        if state.approval != nil { reject() }
        hide()
        listener.resume()
    }

    func toggleWake() {
        state.wakeEnabled.toggle()
        if state.wakeEnabled { listener.startWake() } else { listener.stopWake() }
    }

    func newConversation() {
        resetForNewRequest()
        state.statusLine = "Next request starts a fresh conversation."
        pendingNewSession = true
    }

    private var pendingNewSession = false

    // MARK: - Core messages

    private func connectionChanged(_ up: Bool) {
        state.connected = up
        if !up { speaker.connectionLost() }
        if up {
            if state.phase == .offline { state.phase = .idle }
            state.statusLine = ""
        } else {
            state.phase = .offline
            requestId = nil
        }
    }

    private func handle(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "ready":
            if let tts = m["tts"] as? String, tts == "local" || tts == "cloud" {
                speaker.requestAudio = { [weak self] id, text in
                    self?.core.send(["type": "speak", "id": id, "text": text])
                }
            } else {
                speaker.requestAudio = nil
            }
        case "speech":
            guard let id = m["id"] as? String, let b64 = m["audio"] as? String,
                  let audio = Data(base64Encoded: b64) else { return }
            speaker.deliver(id: id, audio: audio)
        case "speech.error":
            guard let id = m["id"] as? String else { return }
            speaker.failed(id: id)
            if let message = m["message"] as? String, state.statusLine.isEmpty {
                state.statusLine = "Phoenix's voice is unavailable, using the Mac voice: \(message)"
            }
        case "event":
            guard (m["requestId"] as? String) == requestId, let event = m["event"] as? [String: Any] else { return }
            handleEvent(event)
        case "approval.request":
            guard let p = m["proposal"] as? [String: Any] else { return }
            let payload: String = {
                guard let input = p["input"],
                      let data = try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys]),
                      let text = String(data: data, encoding: .utf8) else { return "" }
                return text
            }()
            state.approval = ApprovalCard(
                id: p["id"] as? String ?? "",
                tool: p["tool"] as? String ?? "",
                tierLabel: p["tierLabel"] as? String ?? "",
                summary: p["summary"] as? String ?? "",
                payload: payload,
                payloadHash: p["payloadHash"] as? String ?? "",
                stage: p["stage"] as? Int ?? 1,
                protectedKinds: p["protectedKinds"] as? [String] ?? []
            )
            state.changingApproval = false
            state.approvalFeedback = ""
            state.phase = .waitingForYou
            show(focus: true)
            if requestChannel == "voice", let card = state.approval {
                speaker.flush()
                speaker.say(card.stage == 2 ? "Are you sure? This shares your \(card.protectedKinds.joined(separator: " and "))." : "This needs your OK.")
            }
        case "tool.call":
            runToolCall(m)
        case "done":
            guard (m["requestId"] as? String) == requestId else { return }
            requestId = nil
            let status = m["status"] as? String ?? "failed"
            state.phase = status == "completed" ? .done : .failed
            let text = m["text"] as? String ?? ""
            if status == "completed" {
                if state.replyText.isEmpty { state.replyText = text }
            } else if !text.isEmpty && !state.replyText.contains(text) {
                // Show a failure once, as a status line, not also as Phoenix's reply.
                state.statusLine = text
            }
            if status != "completed" && requestChannel == "voice" && !speaker.isSpeaking {
                speaker.say(status == "cancelled" ? "Stopped." : "Sorry, that didn't work.")
            }
            if requestChannel == "voice" { speaker.flush() } else { scheduleHide() }
        case "error":
            state.statusLine = m["message"] as? String ?? "error"
        default:
            break
        }
    }

    private func handleEvent(_ e: [String: Any]) {
        switch e["type"] as? String {
        case "assistant.delta":
            let text = e["text"] as? String ?? ""
            appendReply(text)
            turnHadDeltas = true
            if state.phase == .thinking { state.phase = .working }
            if requestChannel == "voice" { speaker.feed(text) }
        case "assistant.text":
            let text = e["text"] as? String ?? ""
            if !turnHadDeltas {
                appendReply(text)
                if requestChannel == "voice" { speaker.feed(text) }
            }
            if requestChannel == "voice" { speaker.flush() }
            turnHadDeltas = false
            needsBreak = true
        case "tool.running":
            state.steps.append(Step(text: e["summary"] as? String ?? "", state: .running))
            state.phase = .working
        case "tool.result":
            if let i = state.steps.lastIndex(where: { $0.state == .running }) {
                state.steps[i].state = (e["ok"] as? Bool ?? false) ? .ok : .failed
            }
        case "tool.blocked":
            state.steps.append(Step(text: "Blocked: \(e["tool"] as? String ?? "")", state: .blocked))
        default:
            break
        }
    }

    private func appendReply(_ text: String) {
        if needsBreak && !state.replyText.isEmpty && !text.isEmpty { state.replyText += "\n\n" }
        needsBreak = false
        state.replyText += text
    }

    private func runToolCall(_ m: [String: Any]) {
        guard let callId = m["callId"] as? String, let tool = m["tool"] as? String else { return }
        let input = m["input"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                switch tool {
                case "calendar_events":
                    let output = try await calendar.events(
                        fromISO: input["from"] as? String ?? "",
                        toISO: input["to"] as? String ?? ""
                    )
                    core.send(["type": "tool.result", "callId": callId, "ok": true, "output": output])
                default:
                    throw PhoenixError("this Mac app can't do \(tool)")
                }
            } catch {
                core.send(["type": "tool.result", "callId": callId, "ok": false, "error": error.localizedDescription])
            }
        }
    }

    // MARK: - Voice flow

    /// "Phoenix, stop" while speaking: go quiet and cancel what Phoenix was doing.
    private func heardStop(_ heard: String) {
        // Phoenix's own voice can reach the mic; never let it stop itself.
        if speaker.recentlySaid(heard) {
            if speaker.isSpeaking { listener.listenForInterrupt() }
            return
        }
        stopSpeaking()
        if state.busy { core.send(["type": "cancel"]) }
        state.statusLine = "Stopped. Say “Phoenix, rise” when you need me."
    }

    private func heardWake() {
        speaker.stop()
        if state.busy { return }
        stats.recordWake()
        wokeByPhrase = true
        resetForNewRequest()
        state.channel = "voice"
        state.phase = .listening
        summon()
    }

    /// Summon the voice box with the AI core boot-up (about a second), then open it.
    /// Skipped if the box is already open or "Reduce motion" is on.
    private func summon(focus: Bool = false) {
        if (panel.isVisible && panel.alphaValue > 0.99) || SummonOverlay.reduceMotion {
            rise()
            show(focus: focus)
            return
        }
        // Lay the panel out invisibly first, then aim the effect at where it really is.
        panel.prepareInvisibly()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self else { return }
            let frame = self.panel.frame
            let core = self.state.coreCenterInPanel.map { self.panel.screenPoint(fromPanel: $0) }
                ?? NSPoint(x: frame.minX + 59, y: frame.maxY - 90)
            let screen = self.panel.screen ?? NSScreen.main ?? NSScreen.screens[0]
            self.summonFX.play(core: core, panel: frame, on: screen) { [weak self] in
                guard let self else { return }
                self.rise()
                self.show(focus: focus)
            }
        }
    }

    /// Play the rise animation (wings unfurl, ring of fire, burst of sparks).
    private func rise() {
        state.riseStartedAt = Date()
    }

    private func listenTimedOut() {
        if wokeByPhrase {
            stats.recordFalseWake()   // woke up, but no request followed
            wokeByPhrase = false
        }
        if state.phase == .listening {
            state.phase = .idle
            hide()
        }
    }

    /// First sound of a reply: record how long it took after you stopped talking.
    private func firstAudio() {
        guard let start = measureFrom else { return }
        measureFrom = nil
        let seconds = Date().timeIntervalSince(start)
        stats.recordLatency(seconds)
        state.latencyText = String(format: "%.1f s", seconds)
        state.latencyGood = seconds < PhoenixStats.latencyTarget
    }

    private func speakingFinished() {
        if !state.busy && requestId == nil {
            scheduleHide()
        }
        listener.resume()
    }

    // MARK: - Panel

    private func resetForNewRequest() {
        hideWork?.cancel()
        state.latencyText = ""
        state.userText = ""
        state.replyText = ""
        state.steps = []
        state.approval = nil
        state.statusLine = ""
        turnHadDeltas = false
        needsBreak = false
    }

    func show(focus: Bool = false) {
        hideWork?.cancel()
        panel.present(focus: focus)
    }

    func hide() {
        hideWork?.cancel()
        state.typing = false
        panel.orderOut(nil)
        panel.alphaValue = 1
        if !state.busy && state.connected { state.phase = .idle }
    }

    private func scheduleHide() {
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.state.busy, self.state.approval == nil, !self.state.typing else { return }
                self.hide()
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
    }
}
