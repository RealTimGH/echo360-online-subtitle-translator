import AppKit
import Foundation

/// Native macOS foreground host for the packaged Python backend.
///
/// The Python executable next to this binary remains responsible for HTTP,
/// translation, and model loading. AppKit owns the one GUI event loop and
/// receives the child's output through a pipe, so the UI has no embedded web
/// view, Tcl/Tk runtime, polling thread, or second event loop.
final class BackendAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private static let maxLogLines = 500
    // A child can emit a malformed/no-newline diagnostic indefinitely. Keep
    // both the cross-thread queue and the current partial line bounded so a
    // noisy process cannot grow the host's memory without limit.
    private static let maxQueuedOutputBytes = 1_048_576
    private static let maxPendingLineBytes = 65_536
    private static let maxLogLineBytes = 16_384
    private let coreName = "echo360-subtitle-backend-core"
    private let outputQueueLock = NSLock()

    private var window: NSWindow!
    private var statusField: NSTextField!
    private var detailField: NSTextField!
    private var logView: NSTextView!
    private var backendProcess: Process?
    private var outputPipe: Pipe?
    private var pendingOutput = ""
    private var queuedOutput = ""
    private var outputDrainScheduled = false
    private var logRefreshScheduled = false
    private var logLines: [String] = []
    private var requestCount = 0
    private var listenSummary = "监听 127.0.0.1:8765"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildWindow()
        launchBackend()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackend()
    }

    func windowWillClose(_ notification: Notification) {
        stopBackend()
        NSApp.terminate(nil)
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        appMenu.addItem(
            withTitle: "Quit Echo360 Subtitle Backend",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Echo360 Subtitle Backend"
        window.minSize = NSSize(width: 640, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self

        let contentView = NSView()
        contentView.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = contentView

        let titleField = NSTextField(labelWithString: "Echo360 Subtitle Backend")
        titleField.translatesAutoresizingMaskIntoConstraints = false
        titleField.font = NSFont.systemFont(ofSize: 17, weight: .semibold)

        statusField = NSTextField(labelWithString: "启动中…")
        statusField.translatesAutoresizingMaskIntoConstraints = false
        statusField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        statusField.textColor = .systemOrange

        detailField = NSTextField(labelWithString: listenSummary)
        detailField.translatesAutoresizingMaskIntoConstraints = false
        detailField.font = NSFont.systemFont(ofSize: 12)
        detailField.textColor = .secondaryLabelColor

        logView = NSTextView()
        logView.isEditable = false
        logView.isSelectable = true
        logView.isRichText = false
        logView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        logView.textColor = .textColor
        logView.backgroundColor = .textBackgroundColor
        logView.drawsBackground = true
        logView.isVerticallyResizable = true
        logView.isHorizontallyResizable = false
        logView.autoresizingMask = [.width]
        logView.minSize = NSSize(width: 0, height: 0)
        logView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        logView.textContainer?.widthTracksTextView = true

        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .bezelBorder
        scrollView.documentView = logView

        contentView.addSubview(titleField)
        contentView.addSubview(statusField)
        contentView.addSubview(detailField)
        contentView.addSubview(scrollView)

        NSLayoutConstraint.activate([
            titleField.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            titleField.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 18),
            statusField.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            statusField.centerYAnchor.constraint(equalTo: titleField.centerYAnchor),
            detailField.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            detailField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 6),
            detailField.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            scrollView.topAnchor.constraint(equalTo: detailField.bottomAnchor, constant: 14),
            scrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -20),
            logView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor)
        ])

        appendLogLine("等待后端核心启动…")
        refreshLogView()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func launchBackend() {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        let coreURL = executable.deletingLastPathComponent().appendingPathComponent(coreName)
        listenSummary = listenDescription(from: Array(CommandLine.arguments.dropFirst()))
        detailField.stringValue = listenSummary

        guard FileManager.default.isExecutableFile(atPath: coreURL.path) else {
            reportLaunchFailure("找不到后端核心：\(coreURL.path)")
            return
        }

        let child = Process()
        child.executableURL = coreURL
        child.arguments = Array(CommandLine.arguments.dropFirst()).filter { argument in
            !argument.hasPrefix("echo360-subtitle-backend://") && !argument.hasPrefix("-psn_")
        }

        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = pipe
        var environment = ProcessInfo.processInfo.environment
        environment["ECHO360_NATIVE_CORE"] = "1"
        environment["PYTHONUNBUFFERED"] = "1"
        child.environment = environment
        child.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.backendProcess = nil
                self.outputPipe?.fileHandleForReading.readabilityHandler = nil
                self.drainQueuedOutputAndFlush()
                let code = process.terminationStatus
                self.setStatus("后端已停止", color: .systemRed)
                self.detailField.stringValue = "退出码：\(code)"
                self.appendLogLine("后端核心已退出，退出码 \(code)。")
                self.scheduleLogRefresh()
            }
        }

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async {
                    self?.drainQueuedOutputAndFlush()
                }
                return
            }
            let output = String(decoding: data, as: UTF8.self)
            guard !output.isEmpty else { return }
            self?.enqueueOutput(output)
        }

        backendProcess = child
        outputPipe = pipe
        do {
            try child.run()
            setStatus("运行中", color: .systemGreen)
            appendLogLine("后端核心已启动。")
            refreshLogView()
        } catch {
            backendProcess = nil
            outputPipe = nil
            pipe.fileHandleForReading.readabilityHandler = nil
            reportLaunchFailure("后端核心启动失败：\(error.localizedDescription)")
        }
    }

    private func stopBackend() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if let process = backendProcess, process.isRunning {
            process.terminate()
        }
        backendProcess = nil
        outputPipe = nil
    }

    private func reportLaunchFailure(_ message: String) {
        setStatus("启动失败", color: .systemRed)
        detailField.stringValue = "请检查应用包中的后端核心"
        appendLogLine(message)
        scheduleLogRefresh()
    }

    private func appendOutput(_ output: String) {
        pendingOutput += output
        if pendingOutput.utf8.count > Self.maxPendingLineBytes {
            pendingOutput = boundedUtf8Suffix(pendingOutput, maxBytes: Self.maxPendingLineBytes)
        }
        let parts = pendingOutput.components(separatedBy: "\n")
        let completeLines = parts.dropLast()
        pendingOutput = parts.last ?? ""
        for line in completeLines {
            appendLogLine(line.trimmingCharacters(in: CharacterSet(charactersIn: "\r")))
        }
        scheduleLogRefresh()
    }

    private func flushPendingOutput() {
        guard !pendingOutput.isEmpty else { return }
        appendLogLine(pendingOutput.trimmingCharacters(in: CharacterSet(charactersIn: "\r")))
        pendingOutput = ""
        scheduleLogRefresh()
    }

    private func enqueueOutput(_ output: String) {
        guard !output.isEmpty else { return }
        var shouldSchedule = false
        outputQueueLock.lock()
        queuedOutput += output
        if queuedOutput.utf8.count > Self.maxQueuedOutputBytes {
            queuedOutput = boundedUtf8Suffix(queuedOutput, maxBytes: Self.maxQueuedOutputBytes)
        }
        if !outputDrainScheduled {
            outputDrainScheduled = true
            shouldSchedule = true
        }
        outputQueueLock.unlock()
        if shouldSchedule {
            DispatchQueue.main.async { [weak self] in
                self?.drainQueuedOutput()
            }
        }
    }

    private func drainQueuedOutput() {
        outputQueueLock.lock()
        let output = queuedOutput
        queuedOutput = ""
        outputDrainScheduled = false
        outputQueueLock.unlock()
        if !output.isEmpty {
            appendOutput(output)
        }
    }

    private func drainQueuedOutputAndFlush() {
        // EOF is delivered after the pipe has no more bytes. Drain anything
        // already queued before publishing the final unterminated line.
        outputQueueLock.lock()
        outputDrainScheduled = true
        outputQueueLock.unlock()
        while true {
            outputQueueLock.lock()
            let output = queuedOutput
            queuedOutput = ""
            if output.isEmpty {
                outputDrainScheduled = false
                outputQueueLock.unlock()
                break
            }
            outputQueueLock.unlock()
            appendOutput(output)
        }
        flushPendingOutput()
    }

    private func appendLogLine(_ line: String) {
        let boundedLine = boundedUtf8Suffix(line, maxBytes: Self.maxLogLineBytes)
        logLines.append(boundedLine)
        if logLines.count > Self.maxLogLines {
            logLines.removeFirst(logLines.count - Self.maxLogLines)
        }
        if boundedLine.contains(" HTTP/") {
            requestCount += 1
            detailField?.stringValue = "\(listenSummary) · 已处理 \(requestCount) 个请求"
        }
    }

    private func refreshLogView() {
        guard logView != nil else { return }
        logView.string = logLines.joined(separator: "\n")
        if !logLines.isEmpty {
            logView.string += "\n"
            logView.scrollToEndOfDocument(nil)
        }
    }

    private func scheduleLogRefresh() {
        guard !logRefreshScheduled else { return }
        logRefreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.logRefreshScheduled = false
            self.refreshLogView()
        }
    }

    private func boundedUtf8Suffix(_ value: String, maxBytes: Int) -> String {
        guard maxBytes > 0, value.utf8.count > maxBytes else { return value }
        let bytes = value.utf8
        var start = bytes.index(bytes.endIndex, offsetBy: -maxBytes)
        // Skip a truncated code point rather than introducing a replacement
        // character whose encoding could exceed the byte budget.
        while start < bytes.endIndex && (bytes[start] & 0xC0) == 0x80 {
            start = bytes.index(after: start)
        }
        return String(decoding: bytes[start...], as: UTF8.self)
    }

    private func setStatus(_ value: String, color: NSColor) {
        statusField?.stringValue = value
        statusField?.textColor = color
    }

    private func listenDescription(from arguments: [String]) -> String {
        var host = "127.0.0.1"
        var port = "8765"
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--host", index + 1 < arguments.count {
                host = arguments[index + 1]
                index += 1
            } else if argument.hasPrefix("--host=") {
                host = String(argument.dropFirst("--host=".count))
            } else if argument == "--port", index + 1 < arguments.count {
                port = arguments[index + 1]
                index += 1
            } else if argument.hasPrefix("--port=") {
                port = String(argument.dropFirst("--port=".count))
            }
            index += 1
        }
        return "监听 \(host):\(port)"
    }
}

extension BackendAppDelegate {
    // A URL launch is a wake-up signal. If the app is already open but its
    // child has stopped, restart the child so the extension's next health
    // check can recover the service.
    func application(_ application: NSApplication, open urls: [URL]) -> Bool {
        if backendProcess == nil || backendProcess?.isRunning == false {
            launchBackend()
        }
        return true
    }
}

let application = NSApplication.shared
let delegate = BackendAppDelegate()
application.delegate = delegate
application.run()
