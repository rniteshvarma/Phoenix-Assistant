import Foundation

/// WebSocket connection to the Phoenix core (`npm run phoenix -- serve`) on this Mac.
/// Authenticates with the token the core writes to its data folder; reconnects automatically.
final class CoreClient: NSObject {
    var onMessage: (([String: Any]) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private let port: Int
    private var task: URLSessionWebSocketTask?
    private lazy var session = URLSession(configuration: .ephemeral)
    private var reconnectScheduled = false

    init(port: Int = 7788) {
        self.port = port
    }

    static var phoenixHome: URL {
        if let custom = UserDefaults.standard.string(forKey: "phoenixHome") {
            return URL(fileURLWithPath: custom)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Phoenix")
    }

    func start() {
        connect()
    }

    func send(_ message: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func connect() {
        reconnectScheduled = false
        let tokenURL = Self.phoenixHome.appendingPathComponent("gateway.token")
        guard let raw = try? String(contentsOf: tokenURL, encoding: .utf8) else {
            scheduleReconnect()
            return
        }
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)")!)
        request.setValue("Bearer \(raw.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        // Default is 1 MB; a long spoken sentence can be bigger than that.
        task.maximumMessageSize = 16 * 1024 * 1024
        self.task = task
        task.resume()
        receive(on: task)
        send([
            "type": "hello",
            "device": "Mac",
            "capabilities": ["calendar.read"],
        ])
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                var data: Data?
                switch message {
                case .string(let text): data = text.data(using: .utf8)
                case .data(let bytes): data = bytes
                @unknown default: break
                }
                if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async {
                        if object["type"] as? String == "ready" { self.onConnectionChange?(true) }
                        self.onMessage?(object)
                    }
                }
                self.receive(on: task)
            case .failure:
                DispatchQueue.main.async {
                    guard self.task === task else { return }
                    self.task = nil
                    self.onConnectionChange?(false)
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        guard !reconnectScheduled else { return }
        reconnectScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.connect() }
    }
}
