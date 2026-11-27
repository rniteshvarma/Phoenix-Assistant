import AVFoundation
import Speech

/// Listens for "Phoenix, rise", then captures the request until you stop talking.
/// While Phoenix is speaking it listens only for "Phoenix, stop" (interrupt mode).
/// Recognition runs **on this Mac** (Apple's on-device speech model); if on-device
/// recognition isn't available, the always-on wake word stays off rather than
/// streaming your microphone to a server.
final class VoiceListener {
    enum Mode { case off, wake, command, interrupt }

    var onWake: (() -> Void)?
    var onPartial: ((String) -> Void)?
    var onCommand: ((String) -> Void)?
    var onCommandEmpty: (() -> Void)?
    var onLevel: ((Float) -> Void)?
    /// "Phoenix, stop" heard while Phoenix was speaking; passes the words that matched.
    var onInterrupt: ((String) -> Void)?

    private(set) var mode: Mode = .off
    private(set) var onDevice = false

    private var recognizer: SFSpeechRecognizer?
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var pushToTalk = false
    private var wakeWanted = false
    private var paused = false
    private var silenceTimer: Timer?
    private var refreshTimer: Timer?
    private var lastLevelAt = Date.distantPast
    private var latestCommand = ""

    /// "Phoenix, rise" — tolerant of how speech recognition may spell it
    /// ("Phoenix rise", "Phoenix arise", "Phenix rice", …).
    private static let wakePattern = "\\b(phoenix|phenix|fenix|feenix|phoenix's)[,.!?…]?\\s+a?(rise|rises|rize|ryse|rice|rhys)\\b"

    /// "Phoenix, stop" / "stop, Phoenix" / "Phoenix, quiet" / "Phoenix, enough" / "Phoenix, cancel".
    static let stopPattern =
        "\\b(phoenix|phenix|fenix|feenix)[,.!?…]?\\s+(stop|quiet|enough|cancel|shut up|be quiet)\\b" +
        "|\\b(stop|quiet)[,.!?…]?\\s+(phoenix|phenix|fenix|feenix)\\b"

    /// Ask for microphone + speech permission and pick an on-device recogniser.
    func prepare() async -> String? {
        let speechOK = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard speechOK else {
            return "Speech recognition is off. Allow it in System Settings › Privacy & Security › Speech Recognition."
        }
        let micOK = await AVCaptureDevice.requestAccess(for: .audio)
        guard micOK else {
            return "Microphone access is off. Allow it in System Settings › Privacy & Security › Microphone."
        }
        let candidates = [Locale.current, Locale(identifier: "en-IN"), Locale(identifier: "en-US")]
        for locale in candidates {
            if let r = SFSpeechRecognizer(locale: locale), r.isAvailable, r.supportsOnDeviceRecognition {
                recognizer = r
                onDevice = true
                return nil
            }
        }
        recognizer = nil
        return "On-device speech isn't available. Turn on Dictation in System Settings › Keyboard so Phoenix can recognise speech privately."
    }

    /// Always-on "Phoenix, rise" mode.
    func startWake() {
        wakeWanted = true
        guard !paused, mode == .off else { return }
        begin(.wake)
    }

    func stopWake() {
        wakeWanted = false
        if mode == .wake { end() }
    }

    /// Hotkey: skip the wake word and capture a request right away.
    func startCommand() {
        guard recognizer != nil else { return }
        paused = false
        pushToTalk = true
        if mode != .off { end() }
        begin(.command)
        armSilence(seconds: 6)
    }

    /// Send what has been heard so far (e.g. hotkey pressed again).
    func finishCommand() {
        guard mode == .command else { return }
        silenceTimer?.invalidate()
        complete()
    }

    /// While Phoenix speaks: listen only for "Phoenix, stop".
    func listenForInterrupt() {
        guard recognizer != nil else { return }
        paused = true
        if mode == .interrupt { return }
        if mode != .off { end() }
        begin(.interrupt)
    }

    /// Stop listening entirely (e.g. while Phoenix speaks with voice listening turned off).
    func pause() {
        paused = true
        if mode != .off { end() }
    }

    func resume() {
        paused = false
        if mode == .interrupt { end() }
        if wakeWanted && mode == .off { begin(.wake) }
    }

    // MARK: - Recognition

    private func begin(_ newMode: Mode) {
        guard let recognizer else { return }
        do {
            try startEngine()
        } catch {
            mode = .off
            return
        }
        mode = newMode
        latestCommand = ""
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.addsPunctuation = true
        req.contextualStrings = ["Phoenix, rise", "Phoenix rise", "Phoenix, stop", "Phoenix"]
        lock.lock(); request = req; lock.unlock()
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error, for: req) }
        }
        if newMode == .wake || newMode == .interrupt {
            // Restart periodically so the running transcript never grows large.
            refreshTimer?.invalidate()
            let interval: TimeInterval = newMode == .interrupt ? 20 : 50
            refreshTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
                guard let self, self.mode == newMode else { return }
                self.end()
                if newMode == .interrupt { self.begin(.interrupt) }
                else if self.wakeWanted && !self.paused { self.begin(.wake) }
            }
        }
    }

    private func end() {
        silenceTimer?.invalidate()
        refreshTimer?.invalidate()
        task?.cancel()
        task = nil
        lock.lock(); request?.endAudio(); request = nil; lock.unlock()
        stopEngine()
        mode = .off
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?, for req: SFSpeechAudioBufferRecognitionRequest) {
        lock.lock(); let current = request; lock.unlock()
        guard req === current else { return } // stale task
        if let result {
            process(result.bestTranscription.formattedString)
        }
        if error != nil || result?.isFinal == true {
            let previous = mode
            if previous == .command && !latestCommand.isEmpty { complete(); return }
            end()
            if previous == .wake && wakeWanted && !paused { begin(.wake) }
            if previous == .interrupt { begin(.interrupt) }
        }
    }

    private func process(_ transcript: String) {
        switch mode {
        case .wake:
            guard let range = transcript.range(of: Self.wakePattern, options: [.regularExpression, .caseInsensitive]) else { return }
            mode = .command
            pushToTalk = false
            onWake?()
            let command = clean(String(transcript[range.upperBound...]))
            latestCommand = command
            onPartial?(command)
            armSilence(seconds: command.isEmpty ? 6 : 1.4)
        case .command:
            var command = transcript
            if !pushToTalk, let range = transcript.range(of: Self.wakePattern, options: [.regularExpression, .caseInsensitive]) {
                command = String(transcript[range.upperBound...])
            }
            latestCommand = clean(command)
            onPartial?(latestCommand)
            armSilence(seconds: 1.4)
        case .interrupt:
            guard let range = transcript.range(of: Self.stopPattern, options: [.regularExpression, .caseInsensitive]) else { return }
            let heard = String(transcript[range])
            end()
            onInterrupt?(heard)
        case .off:
            break
        }
    }

    private func clean(_ s: String) -> String {
        s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private func armSilence(seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.complete()
        }
    }

    private func complete() {
        let command = latestCommand
        end()
        pushToTalk = false
        if command.count >= 2 {
            onCommand?(command)
        } else {
            onCommandEmpty?()
            if wakeWanted && !paused { begin(.wake) }
        }
    }

    // MARK: - Audio

    private func startEngine() throws {
        guard !engine.isRunning else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock(); let req = self.request; self.lock.unlock()
            req?.append(buffer)
            self.report(level: buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func stopEngine() {
        guard engine.isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func report(level buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) > 0.05, let data = buffer.floatChannelData?[0] else { return }
        lastLevelAt = now
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = sqrt(sum / Float(n))
        let level = min(1, rms * 12)
        DispatchQueue.main.async { self.onLevel?(level) }
    }
}
