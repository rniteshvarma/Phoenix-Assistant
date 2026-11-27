import AppKit
import Foundation
import PDFKit
import Vision

// phoenix-ocr <file>
// Reads text from an image (PNG, JPEG, HEIC, TIFF…) or a PDF entirely on this Mac:
// PDFs use their text layer, falling back to Apple Vision OCR for scanned pages; images use
// Vision OCR. Prints JSON: {"pages":[{"text":"…","method":"text|ocr"}],"kind":"pdf|image"}.
// Nothing is sent anywhere: Vision's text recognition runs on-device.

let maxPages = 25

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false   // ID numbers aren't words
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
}

func render(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale = max(1, 2000 / max(bounds.width, bounds.height))
    let image = page.thumbnail(of: CGSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
}

let args = CommandLine.arguments
guard args.count == 2 else { fail("usage: phoenix-ocr <file>") }
let url = URL(fileURLWithPath: args[1])
guard FileManager.default.isReadableFile(atPath: url.path) else { fail("can't read \(url.path)") }

var pages: [[String: String]] = []
let kind: String
if url.pathExtension.lowercased() == "pdf" {
    kind = "pdf"
    guard let doc = PDFDocument(url: url) else { fail("not a readable PDF") }
    for i in 0..<min(doc.pageCount, maxPages) {
        guard let page = doc.page(at: i) else { continue }
        let layer = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if layer.count >= 25 {
            pages.append(["text": layer, "method": "text"])
        } else if let image = render(page) {
            pages.append(["text": recognize(image), "method": "ocr"])
        }
    }
} else {
    kind = "image"
    guard let image = NSImage(contentsOf: url),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("not a readable image") }
    pages.append(["text": recognize(cg), "method": "ocr"])
}

let out: [String: Any] = ["kind": kind, "pages": pages]
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
