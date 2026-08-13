# MTN FiberX Data Tracker

This is a localhost dashboard that recreates the dark MTN usage view from the reference image and backs it with the Huawei HG8145X7-10 WAN counters exposed by the MTN FiberX router.

## How it works

The router does not expose a ready-made monthly usage history. Its embedded UI exposes cumulative WAN statistics instead:

- `/html/bbsp/common/get_wan_list_ipwanstat.asp`
- `/html/bbsp/common/get_wan_list_pppwanstat.asp`

The local Node server logs into the router, reads RX/TX bytes, calculates the delta since the previous sample, and stores the sample in `data/usage.json`. The browser only talks to `127.0.0.1`, so the router password is never sent to the browser or committed to this project.

The first sync establishes a baseline and records zero usage. The server samples the router every 30 seconds, so the history collector continues running even when the dashboard tab is closed.

The dashboard also checks the Huawei connected-client resources and displays the device name/host, IP or MAC address, SSID, connection duration, negotiated RX/TX Wi-Fi link rates, and signal strength when the firmware returns them. These are link rates, not current internet throughput. This HG8145X7-10 response exposes per-station rates but does not expose per-station byte counters, so exact device usage cannot be calculated from this router. The collector is ready to calculate monthly RX/TX counter deltas automatically if a future firmware response includes those counters; until then the device table correctly shows `Not exposed`.

## Run it

Use Node.js 18 or newer. No package installation is required.

1. Change the router's default password in the Huawei web UI first.
2. Copy `.env.example` to `.env` and set `ROUTER_PASSWORD` to the new password, or export the variables in your shell.
3. Start the server:

```sh
node server.js
```

4. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

The router uses a self-signed certificate, so `ROUTER_INSECURE_TLS=true` is enabled for the local router connection by default. The dashboard server binds to `127.0.0.1` only.

The server-owned 30-second collector is not realtime streaming. It reads cumulative router counters on each poll and records the interval delta, so the latest value can be up to one polling interval old. The device table uses the same cadence when per-device counters are available.

## Run in the background on macOS

Closing the browser does not stop collection as long as `node server.js` remains running. A full laptop shutdown does stop the process and creates a gap that no collector can reconstruct. The included `com.mtn.fiberx.tracker.plist` starts the server at login and restarts it if it exits, so collection resumes after the laptop starts again.

Stop any foreground FiberX server first so only one process owns the configured port, then install the LaunchAgent:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
cp /Users/mac/dev/web/fiberx/com.mtn.fiberx.tracker.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mtn.fiberx.tracker.plist"
launchctl kickstart -k "gui/$(id -u)/com.mtn.fiberx.tracker"
```

The plist is configured for this checkout and the Homebrew Node path shown by `command -v node` on this Mac. If the project or Node installation moves, update those two absolute paths before loading it. Logs go to `/tmp/fiberx-server.log` and `/tmp/fiberx-server-error.log`.

If the dashboard reports that the router reset the connection, stop the server, wait for the Huawei login lockout timer to clear, verify that `ROUTER_PASSWORD` in `.env` matches the current router password, and start the server again. The collector pauses repeated login attempts after a failure so a wrong password does not continuously lock the router.

## Notes

- This tracks the cumulative WAN PPP/IP counters, so it cannot reconstruct days from before the first baseline.
- If the router reboots or resets its counters, the next sample is treated as a new interval instead of creating a negative number.
- A shutdown, sleep period, router outage, or stopped server leaves a history gap; the next successful sample resumes from the new counter value.
- Plan settings and history are local to this checkout. Generated history is ignored by Git.
- Use the dashboard's Export CSV button to export the selected month.
