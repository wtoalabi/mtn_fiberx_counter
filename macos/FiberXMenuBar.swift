import AppKit
import Darwin
import Foundation

/// Provides a lightweight, menu-bar-only companion for the local FiberX web
/// dashboard. The Node server remains responsible for router collection; this
/// process only exposes convenient macOS controls for opening and restarting
/// that local service.
final class FiberXMenuBarController: NSObject, NSApplicationDelegate {
    /// The status item displayed in the macOS menu bar.
    private var statusItem: NSStatusItem?

    /// The menu item whose title reflects the latest local health check.
    private var serviceStatusItem: NSMenuItem?

    /// The in-flight health request, retained so it can be cancelled on exit.
    private var healthRequest: URLSessionDataTask?

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

    /// Cancels any outstanding network request before the helper terminates.
    ///
    /// - Parameter notification: The termination notification supplied by AppKit.
    func applicationWillTerminate(_ notification: Notification) {
        healthRequest?.cancel()
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

    /// Builds the menu shown when the FiberX status item is clicked.
    private func configureMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let dashboardItem = NSMenuItem(
            title: "Open FiberX Dashboard",
            action: #selector(openDashboard(_:)),
            keyEquivalent: ""
        )
        dashboardItem.target = self
        menu.addItem(dashboardItem)

        let serviceMenuItem = NSMenuItem(
            title: "Service: Checking…",
            action: #selector(refreshStatus(_:)),
            keyEquivalent: ""
        )
        serviceMenuItem.target = self
        self.serviceStatusItem = serviceMenuItem
        menu.addItem(serviceMenuItem)

        let refreshItem = NSMenuItem(
            title: "Refresh Service Status",
            action: #selector(refreshStatus(_:)),
            keyEquivalent: "r"
        )
        refreshItem.target = self
        menu.addItem(refreshItem)

        let restartItem = NSMenuItem(
            title: "Restart Collection Service",
            action: #selector(restartService(_:)),
            keyEquivalent: ""
        )
        restartItem.target = self
        menu.addItem(restartItem)

        menu.addItem(NSMenuItem.separator())

        let logsItem = NSMenuItem(
            title: "Open FiberX Logs",
            action: #selector(openLogs(_:)),
            keyEquivalent: ""
        )
        logsItem.target = self
        menu.addItem(logsItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(
            title: "Quit FiberX Menu Bar",
            action: #selector(quit(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem?.menu = menu
    }

    /// Opens the local dashboard in the user's default browser.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func openDashboard(_ sender: Any?) {
        NSWorkspace.shared.open(dashboardURL)
    }

    /// Requests a fresh health check for the local Node service.
    ///
    /// - Parameter sender: The menu item that invoked this action.
    @objc private func refreshStatus(_ sender: Any?) {
        refreshServiceStatus()
    }

    /// Checks the unauthenticated health endpoint and updates the menu-bar
    /// status without sending dashboard credentials or router credentials.
    private func refreshServiceStatus() {
        healthRequest?.cancel()
        serviceStatusItem?.title = "Service: Checking…"
        statusItem?.button?.toolTip = "FiberX: checking service"

        var request = URLRequest(url: healthURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 2
        healthRequest = URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let isHealthy = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.updateServiceStatus(isHealthy: isHealthy)
            }
        }
        healthRequest?.resume()
    }

    /// Applies a health-check result to the status item and status menu entry.
    ///
    /// - Parameter isHealthy: Whether the local FiberX health endpoint answered
    ///   with HTTP 200.
    private func updateServiceStatus(isHealthy: Bool) {
        serviceStatusItem?.title = isHealthy ? "Service: Running" : "Service: Not running"
        serviceStatusItem?.state = isHealthy ? .on : .off
        statusItem?.button?.toolTip = isHealthy
            ? "FiberX: service running"
            : "FiberX: service not running"
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

    /// Schedules a delayed health check so launchd has time to restart Node.
    private func scheduleStatusRefresh() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.refreshServiceStatus()
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

    /// Returns the per-user launchd target for the existing collector service.
    private var launchctlTarget: String {
        "gui/\(getuid())/\(serviceLabel)"
    }
}

/// Keeps the delegate alive for the duration of the AppKit event loop.
let fiberXMenuBarController = FiberXMenuBarController()
NSApplication.shared.delegate = fiberXMenuBarController
NSApplication.shared.run()
