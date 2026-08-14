import AppKit
import Darwin
import Foundation

/// The protected usage summary returned by FiberX's existing dashboard API.
private struct FiberXSummary: Decodable {
    /// Total usage recorded in the selected month.
    let totalUsageBytes: String

    /// Usage recorded for the current calendar day.
    let todayUsageBytes: String

    /// Average usage across recorded days in the selected month.
    let dailyAverageBytes: String

    /// Projected usage at the end of the selected month.
    let projectedMonthEndBytes: String

    /// Timestamp of the most recent successful router sample.
    let lastSyncAt: String?

    /// Recent router transfer-rate estimate, when two samples are available.
    let speed: FiberXSpeed?

    /// Current router connection state exposed by the server.
    let router: FiberXRouter?

    /// The configured unlimited or capped plan settings.
    let settings: FiberXSettings?
}

/// Describes the interval-average WAN transfer rate calculated by FiberX.
private struct FiberXSpeed: Decodable {
    /// Whether both cumulative samples were valid for rate calculation.
    let available: Bool

    /// Download bytes transferred per second during the latest interval.
    let rxBytesPerSecond: String

    /// Upload bytes transferred per second during the latest interval.
    let txBytesPerSecond: String

    /// Duration represented by the rate estimate.
    let intervalSeconds: Int

    /// Explanation shown when the rate is not currently available.
    let reason: String?
}

/// Describes the public router connection fields used by the menu bar.
private struct FiberXRouter: Decodable {
    /// Whether the last router collection succeeded.
    let connected: Bool
}

/// Describes the plan fields needed for the compact menu summary.
private struct FiberXSettings: Decodable {
    /// Either "unlimited" or "capped".
    let planMode: String

    /// The configured cap in gigabytes when the plan is capped.
    let capGb: Double?
}

/// Renders one high-contrast label/value row inside the native status-item
/// menu. Custom views avoid the muted appearance macOS applies to disabled
/// informational menu items while preserving the system menu background.
private final class FiberXMenuRowView: NSView {
    /// The left-aligned metric label.
    private let labelField: NSTextField

    /// The right-aligned metric value.
    private let valueField: NSTextField

    /// Creates a menu row with semibold, full-contrast typography.
    ///
    /// - Parameters:
    ///   - label: The descriptive label shown on the left.
    ///   - value: The initial value shown on the right.
    init(label: String, value: String) {
        labelField = NSTextField(labelWithString: label)
        valueField = NSTextField(labelWithString: value)
        super.init(frame: .zero)
        configureLayout()
    }

    /// Supports AppKit's required coder initializer for completeness; rows are
    /// created programmatically and are not decoded from a storyboard.
    ///
    /// - Parameter coder: The coder supplied by AppKit.
    required init?(coder: NSCoder) {
        labelField = NSTextField(labelWithString: "")
        valueField = NSTextField(labelWithString: "")
        super.init(coder: coder)
        configureLayout()
    }

    /// Updates the right-hand value while retaining the row's typography.
    ///
    /// - Parameters:
    ///   - value: New value text.
    ///   - color: Optional value color, useful for connection state.
    func update(value: String, color: NSColor? = nil) {
        valueField.stringValue = value
        if let color {
            valueField.textColor = color
        }
    }

    /// Configures the fixed-width menu row and its two-column Auto Layout.
    private func configureLayout() {
        translatesAutoresizingMaskIntoConstraints = false
        labelField.translatesAutoresizingMaskIntoConstraints = false
        valueField.translatesAutoresizingMaskIntoConstraints = false

        labelField.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        labelField.textColor = NSColor.labelColor
        labelField.lineBreakMode = .byTruncatingTail

        valueField.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        valueField.textColor = NSColor.labelColor
        valueField.alignment = .right
        valueField.lineBreakMode = .byTruncatingHead

        addSubview(labelField)
        addSubview(valueField)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 430),
            heightAnchor.constraint(equalToConstant: 32),
            labelField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            labelField.centerYAnchor.constraint(equalTo: centerYAnchor),
            valueField.leadingAnchor.constraint(greaterThanOrEqualTo: labelField.trailingAnchor, constant: 12),
            valueField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            valueField.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
}

/// Provides a lightweight, menu-bar-only companion for the local FiberX web
/// dashboard. The Node server remains responsible for router collection; this
/// process authenticates to the existing localhost API and presents a compact
/// usage summary without requiring the full dashboard to be opened.
final class FiberXMenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    /// The status item displayed in the macOS menu bar.
    private var statusItem: NSStatusItem?

    /// The menu shown when the status item is clicked.
    private var menu: NSMenu?

    /// The high-contrast row reporting the collector's local service state.
    private var serviceStatusRow: FiberXMenuRowView?

    /// The high-contrast row reporting the last router state.
    private var routerStatusRow: FiberXMenuRowView?

    /// The high-contrast row reporting current-month usage.
    private var totalUsageRow: FiberXMenuRowView?

    /// The high-contrast row reporting current-day usage.
    private var todayUsageRow: FiberXMenuRowView?

    /// The high-contrast row reporting the latest interval-average transfer rate.
    private var speedRow: FiberXMenuRowView?

    /// The high-contrast row reporting the month-average usage rate.
    private var averageRow: FiberXMenuRowView?

    /// The high-contrast row reporting the projected month-end usage.
    private var projectedRow: FiberXMenuRowView?

    /// The high-contrast row reporting the configured plan.
    private var planRow: FiberXMenuRowView?

    /// The high-contrast row reporting the timestamp of the last router sample.
    private var lastSyncRow: FiberXMenuRowView?

    /// The high-contrast row used to surface an authentication or data-read failure.
    private var dataStatusRow: FiberXMenuRowView?

    /// The in-flight health request, retained so it can be cancelled on exit.
    private var healthRequest: URLSessionDataTask?

    /// The in-flight protected usage request or login request.
    private var dataRequest: URLSessionDataTask?

    /// Whether a summary request is already loading or authenticating.
    private var isSummaryLoading = false

    /// An ephemeral cookie store keeps the dashboard session in memory only.
    private let urlSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 8
        return URLSession(configuration: configuration)
    }()

    /// The LaunchAgent label installed by the existing FiberX launcher.
    private let serviceLabel = "com.mtn.fiberx.tracker"

    /// Starts the menu-bar controller after AppKit has finished launching.
    ///
    /// - Parameter notification: The launch notification supplied by AppKit.
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureStatusItem()
        configureMenu()
        refreshServiceStatus()
    }

    /// Cancels outstanding network requests before the helper terminates.
    ///
    /// - Parameter notification: The termination notification supplied by AppKit.
    func applicationWillTerminate(_ notification: Notification) {
        healthRequest?.cancel()
        dataRequest?.cancel()
        urlSession.invalidateAndCancel()
    }

    /// Refreshes the service and usage rows whenever the native dropdown opens.
    ///
    /// - Parameter menu: The menu that is about to become visible.
    func menuWillOpen(_ menu: NSMenu) {
        refreshServiceStatus()
        refreshSummary()
    }

    /// Creates the square status item and assigns a template SF Symbol so it
    /// remains legible in both light and dark menu bars.
    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.toolTip = "FiberX"
            if let image = NSImage(
                systemSymbolName: "chart.bar.fill",
                accessibilityDescription: "FiberX"
            ) {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "F"
            }
        }
        statusItem = item
    }

    /// Builds the native dropdown with read-only usage rows and operational
    /// actions. The layout follows macOS status-item menus rather than opening
    /// a browser window for routine checks.
    private func configureMenu() {
        let fiberXMenu = NSMenu()
        fiberXMenu.autoenablesItems = false
        fiberXMenu.delegate = self

        let headerItem = makeMenuHeaderItem(in: fiberXMenu)
        headerItem.attributedTitle = NSAttributedString(
            string: "FiberX",
            attributes: [.font: NSFont.boldSystemFont(ofSize: 14)]
        )

        serviceStatusRow = makeMetricRow(label: "Service", value: "Checking…", in: fiberXMenu)
        routerStatusRow = makeMetricRow(label: "Router", value: "Waiting for sync", in: fiberXMenu)
        fiberXMenu.addItem(NSMenuItem.separator())

        totalUsageRow = makeMetricRow(label: "Total this month", value: "--", in: fiberXMenu)
        todayUsageRow = makeMetricRow(label: "Today", value: "--", in: fiberXMenu)
        speedRow = makeMetricRow(label: "Recent speed", value: "--", in: fiberXMenu)
        averageRow = makeMetricRow(label: "Daily average", value: "--", in: fiberXMenu)
        projectedRow = makeMetricRow(label: "Projected month end", value: "--", in: fiberXMenu)
        planRow = makeMetricRow(label: "Plan", value: "--", in: fiberXMenu)
        lastSyncRow = makeMetricRow(label: "Last sync", value: "--", in: fiberXMenu)
        dataStatusRow = makeMetricRow(label: "Data", value: "Open the menu to refresh", in: fiberXMenu)

        fiberXMenu.addItem(NSMenuItem.separator())

        let refreshItem = NSMenuItem(
            title: "Refresh Information",
            action: #selector(refreshStatus(_:)),
            keyEquivalent: "r"
        )
        refreshItem.target = self
        fiberXMenu.addItem(refreshItem)

        let dashboardItem = NSMenuItem(
            title: "Open Dashboard (optional)",
            action: #selector(openDashboard(_:)),
            keyEquivalent: ""
        )
        dashboardItem.target = self
        fiberXMenu.addItem(dashboardItem)

        let restartItem = NSMenuItem(
            title: "Restart Collection Service",
            action: #selector(restartService(_:)),
            keyEquivalent: ""
        )
        restartItem.target = self
        fiberXMenu.addItem(restartItem)

        fiberXMenu.addItem(NSMenuItem.separator())

        let logsItem = NSMenuItem(
            title: "Open FiberX Logs",
            action: #selector(openLogs(_:)),
            keyEquivalent: ""
        )
        logsItem.target = self
        fiberXMenu.addItem(logsItem)

        let quitItem = NSMenuItem(
            title: "Quit FiberX Menu Bar",
            action: #selector(quit(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = self
        fiberXMenu.addItem(quitItem)

        menu = fiberXMenu
        statusItem?.menu = fiberXMenu
    }

    /// Creates and inserts one full-contrast informational row in the dropdown.
    ///
    /// - Parameters:
    ///   - label: The left-hand label shown before the first API response.
    ///   - value: The right-hand value shown before the first API response.
    ///   - menu: The dropdown receiving the row.
    /// - Returns: The newly inserted custom row view.
    private func makeMetricRow(label: String, value: String, in menu: NSMenu) -> FiberXMenuRowView {
        let row = FiberXMenuRowView(label: label, value: value)
        let item = NSMenuItem()
        item.view = row
        menu.addItem(item)
        return row
    }

    /// Creates the bold, full-contrast title row at the top of the dropdown.
    ///
    /// - Parameter menu: The dropdown receiving the title row.
    /// - Returns: The title menu item so its typography can be customized.
    private func makeMenuHeaderItem(in menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: "FiberX", action: nil, keyEquivalent: "")
        item.isEnabled = true
        menu.addItem(item)
        return item
    }

    /// Opens the local dashboard in the user's default browser when the user
    /// explicitly chooses the optional dashboard action.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func openDashboard(_ sender: Any?) {
        NSWorkspace.shared.open(dashboardURL)
    }

    /// Requests an immediate refresh of the service status and protected usage
    /// summary without opening the browser dashboard.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func refreshStatus(_ sender: Any?) {
        refreshServiceStatus()
        refreshSummary()
    }

    /// Checks the unauthenticated health endpoint and updates the service row.
    private func refreshServiceStatus() {
        healthRequest?.cancel()
        serviceStatusRow?.update(value: "Checking…", color: NSColor.secondaryLabelColor)
        statusItem?.button?.toolTip = "FiberX: checking service"

        var request = URLRequest(url: healthURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 2
        healthRequest = urlSession.dataTask(with: request) { [weak self] _, response, _ in
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let isHealthy = statusCode == 200 || statusCode == 204
            DispatchQueue.main.async {
                self?.updateServiceStatus(isHealthy: isHealthy)
            }
        }
        healthRequest?.resume()
    }

    /// Applies a health-check result to the service row and status-item tooltip.
    ///
    /// - Parameter isHealthy: Whether the local FiberX health endpoint answered
    ///   successfully.
    private func updateServiceStatus(isHealthy: Bool) {
        serviceStatusRow?.update(
            value: isHealthy ? "Running" : "Not running",
            color: isHealthy ? NSColor.systemGreen : NSColor.systemOrange
        )
        statusItem?.button?.toolTip = isHealthy
            ? "FiberX: service running"
            : "FiberX: service not running"
    }

    /// Starts a protected summary request using the current session cookie, or
    /// authenticates once with the private local dashboard password when the
    /// server has restarted and invalidated the previous session.
    private func refreshSummary() {
        guard !isSummaryLoading else {
            return
        }

        isSummaryLoading = true
        dataStatusRow?.update(value: "Loading…", color: NSColor.secondaryLabelColor)
        fetchSummary(retryAfterLogin: false)
    }

    /// Fetches the current-month summary from the existing authenticated API.
    /// A 401 response is retried once after the menu-bar helper signs in.
    ///
    /// - Parameter retryAfterLogin: Whether the one permitted re-authentication
    ///   retry has already been used.
    private func fetchSummary(retryAfterLogin: Bool) {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        dataRequest = urlSession.dataTask(with: request) { [weak self] data, response, error in
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            let summary = data.flatMap { try? JSONDecoder().decode(FiberXSummary.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                if statusCode == 401 && !retryAfterLogin {
                    self.authenticateAndFetchSummary()
                    return
                }
                guard statusCode == 200, let summary else {
                    let message = error == nil
                        ? "Data unavailable (HTTP \(statusCode))."
                        : "Data unavailable while contacting FiberX."
                    self.finishSummaryWithError(message)
                    return
                }
                self.renderSummary(summary)
                self.isSummaryLoading = false
                self.dataRequest = nil
            }
        }
        dataRequest?.resume()
    }

    /// Signs in to the local dashboard API using the password already stored in
    /// the project's private `.env` file. The password is sent only to the
    /// loopback server and is never displayed or written by the helper.
    private func authenticateAndFetchSummary() {
        guard let password = readDashboardPassword() else {
            finishSummaryWithError("Dashboard password not found in the FiberX .env file.")
            return
        }

        var request = URLRequest(url: loginURL)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let body = try? JSONSerialization.data(withJSONObject: ["password": password]) else {
            finishSummaryWithError("FiberX sign-in request could not be prepared.")
            return
        }
        request.httpBody = body
        dataRequest = urlSession.dataTask(with: request) { [weak self] _, response, error in
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                guard statusCode == 200 else {
                    let message = error == nil
                        ? "FiberX sign-in failed (HTTP \(statusCode))."
                        : "FiberX sign-in could not reach the local service."
                    self.finishSummaryWithError(message)
                    return
                }
                self.fetchSummary(retryAfterLogin: true)
            }
        }
        dataRequest?.resume()
    }

    /// Updates all informational rows from one consistent server response so
    /// the dropdown never mixes values from different refreshes.
    ///
    /// - Parameter summary: The current-month usage summary returned by FiberX.
    private func renderSummary(_ summary: FiberXSummary) {
        totalUsageRow?.update(value: formatBytes(summary.totalUsageBytes), color: NSColor.controlAccentColor)
        todayUsageRow?.update(value: formatBytes(summary.todayUsageBytes), color: NSColor.controlAccentColor)
        averageRow?.update(value: "\(formatBytes(summary.dailyAverageBytes))/day")
        projectedRow?.update(value: formatBytes(summary.projectedMonthEndBytes))
        lastSyncRow?.update(value: formatTimestamp(summary.lastSyncAt), color: NSColor.secondaryLabelColor)

        if let speed = summary.speed, speed.available {
            speedRow?.update(
                value: "↓ \(formatRate(speed.rxBytesPerSecond))  ↑ \(formatRate(speed.txBytesPerSecond))",
                color: NSColor.controlAccentColor
            )
        } else {
            speedRow?.update(value: "Waiting for another sample", color: NSColor.secondaryLabelColor)
        }

        if let settings = summary.settings, settings.planMode == "capped" {
            let cap = settings.capGb.map { String(format: "%.0f GB cap", $0) } ?? "cap configured"
            planRow?.update(value: "Capped (\(cap))")
        } else {
            planRow?.update(value: "Unlimited")
        }

        routerStatusRow?.update(
            value: summary.router?.connected == true ? "Connected" : "Last sync unavailable",
            color: summary.router?.connected == true ? NSColor.systemGreen : NSColor.systemOrange
        )
        dataStatusRow?.update(value: "Updated", color: NSColor.systemGreen)
    }

    /// Marks the summary rows as unavailable without exposing request details
    /// such as passwords, cookies, filesystem paths, or router credentials.
    ///
    /// - Parameter message: A short safe message suitable for the menu.
    private func finishSummaryWithError(_ message: String) {
        isSummaryLoading = false
        dataRequest = nil
        dataStatusRow?.update(value: message, color: NSColor.systemOrange)
    }

    /// Restarts the existing FiberX LaunchAgent without starting a second
    /// foreground Node process or exposing the dashboard beyond localhost.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func restartService(_ sender: Any?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", launchctlTarget]
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                if process.terminationStatus != 0 {
                    self?.updateServiceStatus(isHealthy: false)
                }
                self?.scheduleStatusRefresh()
            }
        }

        do {
            try process.run()
        } catch {
            updateServiceStatus(isHealthy: false)
        }
    }

    /// Schedules delayed service and data refreshes so launchd has time to
    /// restart Node before the menu reports its new state.
    private func scheduleStatusRefresh() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.refreshServiceStatus()
            self?.refreshSummary()
        }
    }

    /// Opens the per-user FiberX log directory in Finder.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func openLogs(_ sender: Any?) {
        let logsURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("FiberX", isDirectory: true)
        NSWorkspace.shared.open(logsURL)
    }

    /// Stops only the menu-bar companion; the background collector remains
    /// managed by its own LaunchAgent and can continue running.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func quit(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// Reads the dashboard password from the same simple KEY=VALUE format used
    /// by the Node server, allowing the helper to reuse the protected API
    /// without storing a second credential.
    ///
    /// - Returns: The configured dashboard password, or nil when unavailable.
    private func readDashboardPassword() -> String? {
        guard let projectDirectory else {
            return nil
        }
        let environmentURL = projectDirectory.appendingPathComponent(".env")
        guard let contents = try? String(contentsOf: environmentURL, encoding: .utf8) else {
            return nil
        }

        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#"), let separator = trimmed.firstIndex(of: "=") else {
                continue
            }
            let key = String(trimmed[..<separator]).trimmingCharacters(in: .whitespaces)
            guard key == "DASHBOARD_PASSWORD" else {
                continue
            }
            var value = String(trimmed[trimmed.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2 {
                let startsWithDoubleQuote = value.first == "\"" && value.last == "\""
                let startsWithSingleQuote = value.first == "'" && value.last == "'"
                if startsWithDoubleQuote || startsWithSingleQuote {
                    value = String(value.dropFirst().dropLast())
                }
            }
            return value.isEmpty ? nil : value
        }
        return nil
    }

    /// Formats exact decimal bytes using the same decimal units as the web
    /// dashboard while keeping the native menu compact.
    ///
    /// - Parameter rawBytes: A decimal byte string returned by the server.
    /// - Returns: A compact data quantity such as "12.40 GB".
    private func formatBytes(_ rawBytes: String) -> String {
        var value = Double(rawBytes) ?? 0
        let units = ["B", "KB", "MB", "GB", "TB"]
        var unitIndex = 0
        while value >= 1_000 && unitIndex < units.count - 1 {
            value /= 1_000
            unitIndex += 1
        }
        if unitIndex == 0 {
            return String(format: "%.0f %@", value, units[unitIndex])
        }
        return String(format: "%.2f %@", value, units[unitIndex])
    }

    /// Formats bytes per second as a network bit rate for the speed row.
    ///
    /// - Parameter rawBytesPerSecond: A decimal byte-per-second string.
    /// - Returns: A compact rate such as "18.4 Mbps".
    private func formatRate(_ rawBytesPerSecond: String) -> String {
        var value = (Double(rawBytesPerSecond) ?? 0) * 8
        let units = ["b/s", "Kbps", "Mbps", "Gbps"]
        var unitIndex = 0
        while value >= 1_000 && unitIndex < units.count - 1 {
            value /= 1_000
            unitIndex += 1
        }
        return String(format: "%.1f %@", value, units[unitIndex])
    }

    /// Formats an ISO timestamp using the Mac's local date and time settings.
    ///
    /// - Parameter timestamp: An ISO-8601 timestamp returned by the server.
    /// - Returns: A short local timestamp or "--" when unavailable.
    private func formatTimestamp(_ timestamp: String?) -> String {
        guard let timestamp,
              let date = ISO8601DateFormatter().date(from: timestamp) else {
            return "--"
        }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// Reads the project directory embedded by the installer so the helper can
    /// authenticate using the existing private `.env` file after installation.
    private var projectDirectory: URL? {
        guard let rawValue = Bundle.main.object(forInfoDictionaryKey: "FiberXProjectDirectory") as? String,
              !rawValue.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: rawValue, isDirectory: true)
    }

    /// Reads the dashboard port embedded by the installer, falling back to the
    /// server's documented default when the bundle metadata is unavailable.
    private var dashboardPort: Int {
        let rawValue = Bundle.main.object(forInfoDictionaryKey: "FiberXDashboardPort")
        let port: Int?
        if let stringValue = rawValue as? String {
            port = Int(stringValue)
        } else if let numberValue = rawValue as? NSNumber {
            port = numberValue.intValue
        } else {
            port = nil
        }

        guard let port, (1...65_535).contains(port) else {
            return 3_000
        }
        return port
    }

    /// Builds the browser URL for the local FiberX dashboard.
    private var dashboardURL: URL {
        URL(string: "http://127.0.0.1:\(dashboardPort)")!
    }

    /// Builds the side-effect-free endpoint used to report whether FiberX is
    /// currently accepting local HTTP requests.
    private var healthURL: URL {
        URL(string: "http://127.0.0.1:\(dashboardPort)/healthz")!
    }

    /// Builds the protected current-month summary endpoint.
    private var usageURL: URL {
        URL(string: "http://127.0.0.1:\(dashboardPort)/api/usage")!
    }

    /// Builds the local login endpoint used to establish the ephemeral session.
    private var loginURL: URL {
        URL(string: "http://127.0.0.1:\(dashboardPort)/api/login")!
    }

    /// Returns the per-user launchd target for the existing collector service.
    private var launchctlTarget: String {
        "gui/\(getuid())/\(serviceLabel)"
    }
}

/// Keeps the delegate alive for the duration of the AppKit event loop.
let fiberXMenuBarController = FiberXMenuBarController()
NSApplication.shared.delegate = fiberXMenuBarController
NSApplication.shared.run()
