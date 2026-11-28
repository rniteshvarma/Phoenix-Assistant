import AppKit
import CoreImage
import AVFoundation
import ImagePlayground
import QuartzCore
import ScreenCaptureKit
import Speech

/// Phase 5: images, screen recordings and video edits, made on this Mac.
/// Images: Apple's on-device Image Playground (the cloud style is never used).
/// Recording: ScreenCaptureKit. Edits and captions: AVFoundation + on-device speech recognition.
/// Every result is a new file in ~/Pictures/Phoenix or ~/Movies/Phoenix.
@MainActor
final class MediaActions {
    private var recorder: ScreenRecorder?
    /// The recogniser holds its delegate weakly: keep the collector alive while it works.
    private var activeCollector: UtteranceCollector?

    func run(_ tool: String, _ input: [String: Any]) async throws -> String {
        func str(_ k: String) -> String? { (input[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func num(_ k: String) -> Double? { (input[k] as? NSNumber)?.doubleValue }
        switch tool {
        case "image_create":
            return try await createImages(prompt: str("prompt") ?? "", style: str("style") ?? "animation",
                                          photo: str("photo"), count: Int(num("count") ?? 2))
        case "screen_record_start": return try await startRecording(audio: input["audio"] as? Bool ?? true)
        case "screen_record_stop": return try await stopRecording()
        case "video_trim":
            let out = try await trim(URL(fileURLWithPath: str("file") ?? ""), start: num("start") ?? 0, end: num("end") ?? 0)
            return "Trimmed copy saved: \(out.path)"
        case "video_captions":
            return try await captions(URL(fileURLWithPath: str("file") ?? ""), language: str("language") ?? "en-IN")
        case "video_remove_silence":
            return try await removeSilence(URL(fileURLWithPath: str("file") ?? ""), minSilence: num("minSilence") ?? 0.8)
        case "media_transcribe":
            let cues = try await transcribe(URL(fileURLWithPath: str("file") ?? ""), language: str("language") ?? "en-IN")
            if cues.isEmpty { return "No speech found." }
            return cues.map { "[\(Self.clock($0.start))] \($0.text)" }.joined(separator: "\n")
        default:
            throw PhoenixError("this Mac app can't do \(tool)")
        }
    }

    // MARK: Output locations

    static func outputDir(_ kind: String) throws -> URL {
        // `-mediaOutputDir <dir>` (self-test) keeps results out of the user's folders.
        let base = UserDefaults.standard.string(forKey: "mediaOutputDir").map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(kind).appendingPathComponent("Phoenix")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    static func newFile(_ kind: String, _ stem: String, _ ext: String) throws -> URL {
        let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate, .withTime])
            .replacingOccurrences(of: ":", with: "")
        let clean = stem.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(40)
        var url = try outputDir(kind).appendingPathComponent("\(clean.isEmpty ? "phoenix" : String(clean))-\(stamp).\(ext)")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = try outputDir(kind).appendingPathComponent("\(clean)-\(stamp)-\(n).\(ext)")
            n += 1
        }
        return url
    }

    static func clock(_ s: Double) -> String {
        let t = Int(s.rounded(.down))
        return String(format: "%d:%02d", t / 60, t % 60)
    }

    // MARK: Images (on-device Image Playground)

    private func createImages(prompt: String, style styleID: String, photo: String?, count: Int) async throws -> String {
        let creator: ImageCreator
        do {
            creator = try await ImageCreator()
        } catch {
            throw PhoenixError("Image Playground isn't available on this Mac (it needs Apple Intelligence turned on in System Settings).")
        }
        let wanted: ImagePlaygroundStyle = styleID == "illustration" ? .illustration : styleID == "sketch" ? .sketch : .animation
        // Only on-device styles: never Apple's external (cloud) provider.
        guard creator.availableStyles.contains(wanted) else {
            throw PhoenixError("The \(styleID) style isn't available right now.")
        }
        var concepts: [ImagePlaygroundConcept] = [.text(prompt)]
        if let photo, let c = ImagePlaygroundConcept.image(URL(fileURLWithPath: photo)) { concepts.append(c) }
        NSApp.activate(ignoringOtherApps: true) // image creation may need the app in front
        var files: [URL] = []
        for try await image in creator.images(for: concepts, style: wanted, limit: max(1, min(4, count))) {
            let url = try Self.newFile("Pictures", prompt, "png")
            guard let png = NSBitmapImageRep(cgImage: image.cgImage).representation(using: .png, properties: [:]) else { continue }
            try png.write(to: url)
            files.append(url)
        }
        guard !files.isEmpty else { throw PhoenixError("No images came back.") }
        NSWorkspace.shared.open(files, withApplicationAt: URL(fileURLWithPath: "/System/Applications/Preview.app"),
                                configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        return "Created \(files.count) image\(files.count == 1 ? "" : "s"), opened in Preview:\n" + files.map(\.path).joined(separator: "\n")
    }

    // MARK: Screen recording

    private func startRecording(audio: Bool) async throws -> String {
        if recorder != nil { return "Already recording. Say stop when you're done." }
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw PhoenixError("Phoenix needs Screen Recording permission (System Settings › Privacy & Security › Screen & System Audio Recording).")
        }
        let url = try Self.newFile("Movies", "screen-recording", "mov")
        let r = ScreenRecorder(url: url)
        try await r.start(audio: audio)
        recorder = r
        // Safety stop after 30 minutes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30 * 60) { [weak self] in
            Task { @MainActor in if self?.recorder === r { _ = try? await self?.stopRecording() } }
        }
        return "Recording the screen\(audio ? " with sound" : ""). Say stop when you're done."
    }

    private func stopRecording() async throws -> String {
        guard let r = recorder else { return "Nothing is being recorded." }
        recorder = nil
        let url = try await r.stop()
        let seconds = (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0
        return "Saved a \(Self.clock(seconds)) recording: \(url.path)"
    }

    // MARK: Video edits

    private func export(_ asset: AVAsset, to url: URL, timeRange: CMTimeRange? = nil, videoComposition: AVVideoComposition? = nil) async throws {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw PhoenixError("This video can't be exported.")
        }
        if let timeRange { session.timeRange = timeRange }
        if let videoComposition { session.videoComposition = videoComposition }
        do {
            try await session.export(to: url, as: url.pathExtension.lowercased() == "mp4" ? .mp4 : .mov)
        } catch {
            throw PhoenixError("Export failed: \(error.localizedDescription)")
        }
    }

    private func trim(_ file: URL, start: Double, end: Double) async throws -> URL {
        let asset = AVURLAsset(url: file)
        let duration = try await asset.load(.duration).seconds
        guard start < duration else { throw PhoenixError("The video is only \(Self.clock(duration)) long.") }
        let out = try Self.newFile("Movies", file.deletingPathExtension().lastPathComponent + "-trimmed", "mov")
        let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: min(end, duration), preferredTimescale: 600))
        try await export(asset, to: out, timeRange: range)
        return out
    }

    struct Cue { let start: Double; let end: Double; let text: String }

    /// On-device speech recognition with word timings, grouped into short caption cues.
    private func transcribe(_ file: URL, language: String) async throws -> [Cue] {
        let auth = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard auth == .authorized else { throw PhoenixError("Speech recognition is off for Phoenix (System Settings › Privacy & Security › Speech Recognition).") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.supportsOnDeviceRecognition else {
            throw PhoenixError("On-device speech recognition isn't available for \(language). Turn on Dictation in System Settings › Keyboard.")
        }
        let request = SFSpeechURLRecognitionRequest(url: file)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        // A long pause splits speech into separate utterances: collect every one until the task ends.
        let collector = UtteranceCollector()
        activeCollector = collector
        defer { activeCollector = nil }
        let length = (try? await AVURLAsset(url: file).load(.duration).seconds) ?? 60
        let segments: [SFTranscriptionSegment] = try await withCheckedThrowingContinuation { c in
            collector.finish = { c.resume(with: $0) }
            collector.task = recognizer.recognitionTask(with: request, delegate: collector)
            // Never hang: give up after twice the media length plus a minute.
            DispatchQueue.main.asyncAfter(deadline: .now() + length * 2 + 60) { [weak collector] in
                collector?.task?.cancel()
                collector?.giveUp(PhoenixError("Transcription took too long."))
            }
        }
        var cues: [Cue] = []
        var words: [String] = []
        var cueStart = 0.0, cueEnd = 0.0
        for s in segments {
            // A pause ends the caption, so captions never run across silence.
            if !words.isEmpty && s.timestamp - cueEnd > 0.6 {
                cues.append(Cue(start: cueStart, end: cueEnd, text: words.joined(separator: " ")))
                words = []
            }
            if words.isEmpty { cueStart = s.timestamp }
            words.append(s.substring)
            cueEnd = s.timestamp + s.duration
            if words.count >= 7 || cueEnd - cueStart >= 3 || s.substring.last.map({ ".?!".contains($0) }) == true {
                cues.append(Cue(start: cueStart, end: cueEnd, text: words.joined(separator: " ")))
                words = []
            }
        }
        if !words.isEmpty { cues.append(Cue(start: cueStart, end: cueEnd, text: words.joined(separator: " "))) }
        return cues
    }

    /// A caption as an image: white semibold text on a soft dark pill, wrapped to `maxWidth`.
    static func captionImage(_ text: String, maxWidth: CGFloat, fontSize: CGFloat) -> (CGImage, CGSize)? {
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let attributed = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: para,
        ])
        let padX = fontSize * 0.7, padY = fontSize * 0.35
        let bounds = attributed.boundingRect(with: CGSize(width: maxWidth - padX * 2, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading])
        let size = CGSize(width: ceil(bounds.width) + padX * 2, height: ceil(bounds.height) + padY * 2)
        let scale: CGFloat = 2
        guard let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        ctx.setFillColor(NSColor.black.withAlphaComponent(0.62).cgColor)
        ctx.addPath(CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: fontSize * 0.35, cornerHeight: fontSize * 0.35, transform: nil))
        ctx.fillPath()
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        attributed.draw(with: CGRect(x: padX, y: padY, width: size.width - padX * 2, height: size.height - padY * 2), options: [.usesLineFragmentOrigin, .usesFontLeading])
        NSGraphicsContext.restoreGraphicsState()
        guard let image = ctx.makeImage() else { return nil }
        return (image, size)
    }

    static func srt(_ cues: [Cue]) -> String {
        func ts(_ s: Double) -> String {
            let ms = Int((s * 1000).rounded())
            return String(format: "%02d:%02d:%02d,%03d", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
        }
        return cues.enumerated().map { "\($0.offset + 1)\n\(ts($0.element.start)) --> \(ts($0.element.end))\n\($0.element.text)\n" }.joined(separator: "\n")
    }

    private func captions(_ file: URL, language: String) async throws -> String {
        let cues = try await transcribe(file, language: language)
        guard !cues.isEmpty else { throw PhoenixError("No speech found to caption.") }
        let stem = file.deletingPathExtension().lastPathComponent + "-captioned"
        let srtURL = try Self.newFile("Movies", stem, "srt")
        try Self.srt(cues).write(to: srtURL, atomically: true, encoding: .utf8)

        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw PhoenixError("No video track in that file.") }
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let size = natural.applying(transform)
        let render = CGSize(width: abs(size.width), height: abs(size.height))

        // Each frame is composed with Core Image: the caption image is laid over the frames in its
        // time window. (No Core Animation layers, which an app's export can silently drop.)
        let fontSize = max(18, render.height * 0.045)
        var overlays: [(start: Double, end: Double, image: CIImage)] = []
        for cue in cues {
            guard let (image, box) = Self.captionImage(cue.text, maxWidth: render.width * 0.8, fontSize: fontSize) else { continue }
            let ci = CIImage(cgImage: image)
                .transformed(by: CGAffineTransform(scaleX: box.width / CGFloat(image.width), y: box.height / CGFloat(image.height)))
                .transformed(by: CGAffineTransform(translationX: (render.width - box.width) / 2, y: render.height * 0.06))
            overlays.append((cue.start, max(cue.end, cue.start + 0.3), ci))
        }
        let composition = try await AVMutableVideoComposition.videoComposition(with: asset, applyingCIFiltersWithHandler: { request in
            let t = request.compositionTime.seconds
            var frame = request.sourceImage
            for o in overlays where t >= o.start && t < o.end {
                frame = o.image.composited(over: frame)
            }
            request.finish(with: frame.cropped(to: request.sourceImage.extent), context: nil)
        })
        let out = try Self.newFile("Movies", stem, "mov")
        try await export(asset, to: out, videoComposition: composition)
        return "Captioned copy saved: \(out.path)\nCaptions file: \(srtURL.path)\n\(cues.count) captions."
    }

    private func removeSilence(_ file: URL, minSilence: Double) async throws -> String {
        let asset = AVURLAsset(url: file)
        guard let audio = try await asset.loadTracks(withMediaType: .audio).first else { throw PhoenixError("That video has no sound to judge silences by.") }
        let duration = try await asset.load(.duration).seconds

        // Loudness per 50 ms window.
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: audio, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false, AVNumberOfChannelsKey: 1, AVSampleRateKey: 16_000,
        ])
        reader.add(output)
        reader.startReading()
        let window = 800 // 50 ms at 16 kHz
        var levels: [Float] = []
        var acc: Float = 0, n = 0
        while let buffer = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(buffer) {
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
            guard let pointer else { continue }
            let count = length / MemoryLayout<Float>.size
            pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
                for i in 0..<count {
                    acc += samples[i] * samples[i]
                    n += 1
                    if n == window { levels.append(10 * log10(acc / Float(n) + 1e-12)); acc = 0; n = 0 }
                }
            }
        }
        guard !levels.isEmpty else { throw PhoenixError("Couldn't read the sound in that video.") }

        // Silence = well below the speaking level.
        let sorted = levels.sorted()
        let speech = sorted[Int(Double(sorted.count) * 0.9)]
        let threshold = max(-55, speech - 25)
        let step = 0.05, pad = 0.15
        var keep: [(Double, Double)] = []
        var runStart: Double? = nil
        var lastLoud = 0.0
        for (i, level) in levels.enumerated() {
            let t = Double(i) * step
            if level > threshold {
                if runStart == nil { runStart = max(0, t - pad) }
                lastLoud = t
            } else if let s = runStart, t - lastLoud >= minSilence {
                keep.append((s, min(duration, lastLoud + step + pad)))
                runStart = nil
            }
        }
        if let s = runStart { keep.append((s, duration)) }
        let kept = keep.reduce(0) { $0 + $1.1 - $1.0 }
        guard !keep.isEmpty else { throw PhoenixError("The whole video sounds silent.") }
        if duration - kept < 0.5 { return "There are no silent gaps longer than \(minSilence) s to remove." }

        let composition = AVMutableComposition()
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let v = videoTracks.isEmpty ? nil : composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        let a = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        if let first = videoTracks.first { v?.preferredTransform = try await first.load(.preferredTransform) }
        var cursor = CMTime.zero
        for (s, e) in keep {
            let range = CMTimeRange(start: CMTime(seconds: s, preferredTimescale: 600), end: CMTime(seconds: e, preferredTimescale: 600))
            if let first = videoTracks.first { try v?.insertTimeRange(range, of: first, at: cursor) }
            try a?.insertTimeRange(range, of: audio, at: cursor)
            cursor = cursor + range.duration
        }
        let out = try Self.newFile("Movies", file.deletingPathExtension().lastPathComponent + "-tight", "mov")
        try await export(composition, to: out)
        return "Removed \(Self.clock(duration - kept)) of silence (\(Self.clock(duration)) → \(Self.clock(kept))). Saved: \(out.path)"
    }
}

/// Records the main display (minus Phoenix's own windows) to a movie file with ScreenCaptureKit.
final class ScreenRecorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
    let url: URL
    private var stream: SCStream?

    init(url: URL) { self.url = url }

    func start(audio: Bool) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw PhoenixError("No display to record.")
        }
        let mine = content.applications.filter { $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
        let config = SCStreamConfiguration()
        let scale = Int(NSScreen.main?.backingScaleFactor ?? 2)
        config.width = display.width * scale
        config.height = display.height * scale
        config.showsCursor = true
        config.capturesAudio = audio
        config.captureMicrophone = audio
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        let rc = SCRecordingOutputConfiguration()
        rc.outputURL = url
        rc.outputFileType = .mov
        rc.videoCodecType = .hevc
        try stream.addRecordingOutput(SCRecordingOutput(configuration: rc, delegate: self))
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async throws -> URL {
        try await stream?.stopCapture()
        stream = nil
        try await Task.sleep(nanoseconds: 500_000_000) // let the file finish writing
        return url
    }
}

/// Gathers the final transcription of every utterance in a file, in order.
final class UtteranceCollector: NSObject, SFSpeechRecognitionTaskDelegate {
    var finish: ((Result<[SFTranscriptionSegment], Error>) -> Void)?
    var task: SFSpeechRecognitionTask?
    private var segments: [SFTranscriptionSegment] = []

    func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishRecognition result: SFSpeechRecognitionResult) {
        segments.append(contentsOf: result.bestTranscription.segments)
    }

    func giveUp(_ error: Error) {
        let done = finish
        finish = nil
        done?(segments.isEmpty ? .failure(error) : .success(segments.sorted { $0.timestamp < $1.timestamp }))
    }

    func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishSuccessfully successfully: Bool) {
        let done = finish
        finish = nil
        if successfully || !segments.isEmpty {
            done?(.success(segments.sorted { $0.timestamp < $1.timestamp }))
        } else {
            done?(.failure(task.error ?? PhoenixError("Speech recognition didn't finish.")))
        }
    }
}
