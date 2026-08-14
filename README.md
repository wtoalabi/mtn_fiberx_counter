# MTN FiberX Data Tracker

This is a localhost dashboard that recreates the dark MTN usage view from the reference image and backs it with the Huawei HG8145X7-10 WAN counters exposed by the MTN FiberX router.

## How it works

The router does not expose a ready-made monthly usage history. Its embedded UI exposes cumulative WAN statistics instead:

- `/html/bbsp/common/get_wan_list_ipwanstat.asp`
- `/html/bbsp/common/get_wan_list_pppwanstat.asp`

The local Node server logs into the router, reads RX/TX bytes, calculates the delta since the previous sample, and stores settings and history in `data/fiberx.sqlite` when the built-in SQLite API is available. Older Node.js runtimes automatically fall back to `data/usage.json`. The browser only talks to `127.0.0.1`, so the router password is never sent to the browser or committed to this project.

On first startup with SQLite available, an existing `data/usage.json` is imported automatically and left untouched as a recoverable backup. When SQLite is unavailable, the JSON file remains the active store.

The first sync establishes a baseline and records zero usage. The server samples the router every 30 seconds, so the history collector continues running even when the dashboard tab is closed.

The dashboard also checks the Huawei connected-client resources and displays the device name/host, IP or MAC address, SSID, connection duration, negotiated RX/TX Wi-Fi link rates, and signal strength when the firmware returns them. These are link rates, not current internet throughput. This HG8145X7-10 response exposes per-station rates but does not expose per-station byte counters, so exact device usage cannot be calculated from this router. The collector is ready to calculate monthly RX/TX counter deltas automatically if a future firmware response includes those counters; until then the device table correctly shows `Not exposed`.

## Run it

Use Node.js 18 or newer. Node.js 22.5 or newer uses the built-in `node:sqlite` API; older supported runtimes automatically use JSON. No package installation is required.

1. Change the router's default password in the Huawei web UI first.
2. Copy `.env.example` to `.env`, restrict it to your OS account with `chmod 600 .env`, and set `ROUTER_PASSWORD` to the new password. You can export the variables in your shell instead if you do not want a credential file.
3. Start the server:

```sh
node server.js
```

4. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

TLS certificate verification is enabled by default. If your router uses a self-signed certificate and HTTPS cannot be verified, `ROUTER_INSECURE_TLS=true` is an explicit local-network exception; it makes the router login vulnerable to interception by another device on that network. The dashboard server is hard-bound to `127.0.0.1` and does not accept a configurable public bind address.

The server-owned 30-second collector is not realtime streaming. It reads cumulative router counters on each poll and records the interval delta, so the latest value can be up to one polling interval old. The device table uses the same cadence when per-device counters are available.

## Run in the background on macOS

Closing the browser does not stop collection as long as `node server.js` remains running. A full laptop shutdown does stop live sampling. When the laptop returns, the collector subtracts the last persisted router counter from the latest counter and records the difference as an offline-gap reconciliation. The exact time distribution is unknown, so the amount is assigned to the return sample. The generated LaunchAgent starts the server at login and restarts it if it exits, so collection resumes after the laptop starts again.

Use the included one-command launcher. It discovers the Node.js path, generates the LaunchAgent for this checkout, installs it, starts `server.js` through launchd, and verifies the local dashboard:

```sh
/Users/mac/dev/web/fiberx/start-fiberx.sh
```

If macOS says the script is not executable, run this once and then run the launcher:

```sh
chmod +x /Users/mac/dev/web/fiberx/start-fiberx.sh
/Users/mac/dev/web/fiberx/start-fiberx.sh
```

The generated plist is stored at `~/Library/LaunchAgents/com.mtn.fiberx.tracker.plist`. The script is safe to run again after moving Node or changing the project path; it refreshes the plist and restarts the same service. Logs go to `~/Library/Logs/FiberX/server.log` and `~/Library/Logs/FiberX/server-error.log`.

Do not leave a manually started `node server.js` running when you run the launcher. If port 4000 (or the `PORT` value in `.env`) is already occupied, the script stops and tells you which process must be stopped; it never kills an existing process automatically.

If the dashboard reports that the router reset the connection, stop the server, wait for the Huawei login lockout timer to clear, verify that `ROUTER_PASSWORD` in `.env` matches the current router password, and start the server again. The collector pauses repeated login attempts after a failure so a wrong password does not continuously lock the router.

## Notes

- This tracks the cumulative WAN PPP/IP counters, so it cannot reconstruct days from before the first baseline.
- If the router reboots or resets its counters, the next sample is treated as a new interval instead of creating a negative number.
- A shutdown, sleep period, router outage, or stopped server creates an offline interval. If the router counters continue increasing, the next successful sample reconciles the difference and labels it in the dashboard as usage while away.
- If the router reboots or resets its counters during that interval, the tracker flags the gap and cannot reliably reconstruct the missing usage.
- Plan settings and history are local to this checkout. The SQLite database, its WAL files, and the JSON fallback/backup are ignored by Git and restricted to the current OS account.
- Use the dashboard's Export CSV button to export the selected month.
