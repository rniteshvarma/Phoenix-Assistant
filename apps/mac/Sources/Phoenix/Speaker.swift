import AVFoundation

/// Speaks Phoenix's reply sentence by sentence as it streams in, so the first words
/// come out before the whole answer is ready.
///
/// With Phoenix's voice from the core (local Kokoro, or ElevenLabs if chosen), each sentence is
/// requested as soon as it's complete and played strictly in order. If that voice
/// is unavailable, Phoenix falls back to Apple's on-device voice for the rest of the reply.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    var onStart: (() -> Void)?
    var onIdle: (() -> Void)?
    /// Set when the core offers a voice: sends {id, text} to be synthesised.
    var requestAudio: ((_ id: String, _ text: String) -> Void)?
    /// Fires when speaking starts or stops, so the UI can show a Stop button.
    var onSpeakingChange: ((Bool) -> Void)?
    /// Fires each time audio actually starts playing (used to time the first spoken word).
    var onAudioStart: (() -> Void)?

    private struct Item {
        let id: String
        let text: String
        var audio: Data?
        var failed = false
        let requestedAt = Date()
    }

    /// If a sentence's audio hasn't arrived by then, say it with the Mac voice instead
    /// of leaving Phoenix silent.
    private static let audioTimeout: TimeInterval = 6
    private var watchdog: Timer?
    private var lastReported = false
    /// What Phoenix said recently, so the mic can ignore Phoenix's own voice.
    private var spoken: [(at: Date, text: String)] = []

    private let synth = AVSpeechSynthesizer()
    private var buffer = ""
    private var queue: [Item] = []
    private var player: AVAudioPlayer?
    private var playingLocal = false
    private lazy var appleVoice: AVSpeechSynthesisVoice? = Self.pickVoice()

    var usesCloudVoice: Bool { requestAudio != nil }
    var isSpeaking: Bool { synth.isSpeaking || player?.isPlaying == true || !queue.isEmpty }

    override init() {
        super.init()
        synth.delegate = self
    }

    // MARK: - Input

    /// Add streamed text; complete sentences are spoken (or requested) immediately.
    func feed(_ text: String) {
        buffer += text
        while let end = buffer.range(of: "[.!?…](\\s)|\\n", options: .regularExpression) {
            let sentence = String(buffer[..<end.upperBound])
            buffer.removeSubrange(..<end.upperBound)
            speak(sentence)
        }
    }

    /// Speak whatever is left over (end of a turn).
    func flush() {
        let rest = buffer
        buffer = ""
        speak(rest)
        if !isSpeaking { onIdle?() }
    }

    func say(_ text: String) {
        speak(text)
    }

    func stop() {
        buffer = ""
        queue.removeAll()
        player?.stop()
        player = nil
        playingLocal = false
        watchdog?.invalidate()
        watchdog = nil
        synth.stopSpeaking(at: .immediate)
        report()
    }

    // MARK: - Cloud audio from the core

    func deliver(id: String, audio: Data) {
        guard let i = queue.firstIndex(where: { $0.id == id }) else { return }
        queue[i].audio = audio
        advance()
    }

    func failed(id: String) {
        guard let i = queue.firstIndex(where: { $0.id == id }) else { return }
        queue[i].failed = true
        advance()
    }

    // MARK: - Playback

    private func speak(_ raw: String) {
        let text = raw
            .replacingOccurrences(of: "[*_#`>|]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count > 1 else { return }
        spoken.append((Date(), Self.normalise(text)))
        spoken.removeAll { Date().timeIntervalSince($0.at) > 30 }
        if !isSpeaking { onStart?() }
        for part in Self.splitLong(text) {
            if let requestAudio {
                let id = UUID().uuidString
                queue.append(Item(id: id, text: part))
                requestAudio(id, part)
            } else {
                speakLocally(part)
            }
        }
        armWatchdog()
        report()
    }

    /// Keep chunks short (faster first audio, and within the voice model's limits):
    /// split sentences longer than ~180 characters at commas, semicolons or dashes.
    static func splitLong(_ text: String, limit: Int = 180) -> [String] {
        guard text.count > limit else { return [text] }
        var parts: [String] = []
        var current = ""
        let pieces = text.components(separatedBy: ", ").flatMap { $0.components(separatedBy: "; ") }
        for (i, piece) in pieces.enumerated() {
            let joiner = current.isEmpty ? "" : ", "
            if !current.isEmpty && current.count + joiner.count + piece.count > limit {
                parts.append(current + ",")
                current = piece
            } else {
                current += joiner + piece
            }
            if i == pieces.count - 1 { parts.append(current) }
        }
        // Still too long (no commas): split on word boundaries.
        return parts.flatMap { part -> [String] in
            guard part.count > limit * 2 else { return [part] }
            var out: [String] = []
            var line = ""
            for word in part.split(separator: " ") {
                if line.count + word.count + 1 > limit { out.append(line); line = String(word) }
                else { line += line.isEmpty ? String(word) : " \(word)" }
            }
            if !line.isEmpty { out.append(line) }
            return out
        }
    }

    private func armWatchdog() {
        guard watchdog == nil, requestAudio != nil else { return }
        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if let head = self.queue.first, head.audio == nil, !head.failed,
               Date().timeIntervalSince(head.requestedAt) > Self.audioTimeout {
                self.queue[0].failed = true
                self.advance()
            }
            if self.queue.isEmpty { self.watchdog?.invalidate(); self.watchdog = nil }
        }
    }

    /// True if Phoenix itself said these words in the last ~30 seconds (its voice reaching the mic).
    func recentlySaid(_ phrase: String) -> Bool {
        let needle = Self.normalise(phrase)
        return !needle.isEmpty && spoken.contains { Date().timeIntervalSince($0.at) < 30 && $0.text.contains(needle) }
    }

    private static func normalise(_ s: String) -> String {
        s.lowercased().unicodeScalars
            .map { CharacterSet.letters.contains($0) ? String($0) : " " }
            .joined()
            .split(separator: " ")
            .joined(separator: " ")
    }

    /// The connection to the core dropped: any audio still on its way is lost.
    func connectionLost() {
        for i in queue.indices where queue[i].audio == nil { queue[i].failed = true }
        advance()
    }

    private func report() {
        let now = isSpeaking
        if now != lastReported {
            lastReported = now
            onSpeakingChange?(now)
        }
    }

    /// Play the head of the queue once its audio has arrived (keeps sentences in order).
    private func advance() {
        guard player?.isPlaying != true, !playingLocal, let head = queue.first else { return }
        if let audio = head.audio, let p = try? AVAudioPlayer(data: audio) {
            queue.removeFirst()
            p.delegate = self
            player = p
            p.play()
            onAudioStart?()
        } else if head.failed || (head.audio != nil) {
            // Cloud voice failed for this sentence: say it with Apple's voice instead.
            queue.removeFirst()
            playingLocal = true
            speakLocally(head.text)
        }
    }

    private func speakLocally(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = appleVoice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        utterance.postUtteranceDelay = 0.05
        synth.speak(utterance)
        onAudioStart?()
    }

    private func finishedOne() {
        DispatchQueue.main.async {
            self.playingLocal = false
            self.player = nil
            self.advance()
            self.report()
            if !self.isSpeaking && self.buffer.isEmpty { self.onIdle?() }
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finishedOne()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finishedOne()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.playingLocal = false
            self.report()
            if !self.isSpeaking { self.onIdle?() }
        }
    }

    /// Best installed English voice, preferring the user's region (e.g. en-IN) and premium quality.
    private static func pickVoice() -> AVSpeechSynthesisVoice? {
        let preferred = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        let ranked = english.sorted { a, b in
            let aScore = (a.language == preferred ? 10 : 0) + a.quality.rawValue
            let bScore = (b.language == preferred ? 10 : 0) + b.quality.rawValue
            return aScore > bScore
        }
        return ranked.first ?? AVSpeechSynthesisVoice(language: "en-US")
    }
}
