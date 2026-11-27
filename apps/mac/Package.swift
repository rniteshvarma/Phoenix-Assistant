// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "PhoenixMac",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Phoenix", path: "Sources/Phoenix")
    ]
)
