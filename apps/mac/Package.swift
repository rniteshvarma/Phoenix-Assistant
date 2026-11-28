// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "PhoenixMac",
    platforms: [.macOS("15.4")],
    targets: [
        .executableTarget(name: "Phoenix", path: "Sources/Phoenix"),
        // On-device text recognition for images and PDFs (Vision + PDFKit), used by the core.
        .executableTarget(name: "phoenix-ocr", path: "Sources/PhoenixOCR"),
    ]
)
