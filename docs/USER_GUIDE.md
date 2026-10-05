# FiberX user guide

FiberX reads usage counters from your local MTN FiberX router or Airtel ODU and builds a simple usage history on your computer. This guide covers the normal setup and the controls you use every day.

## 1. Set up FiberX

### Requirements

You need:

- Node.js `24.18.1` or newer within the Node 24 line.
- Access to the Huawei router used by your FiberX connection or to a supported Airtel ODU (tested with ZLT X17U).
- A terminal on the same computer as the router connection.

The app uses Node's built-in features, so you do not need to install npm packages.

### Create the local configuration

From the project directory:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` and replace the placeholders:

| Setting | What it means |
| --- | --- |
| `DASHBOARD_PASSWORD` | Password used to sign in to FiberX. Use a unique value with at least 20 characters. |
| `ROUTER_SOURCE` | Router integration: `auto` (recommended), `huawei`, or `zlt`. This is not the ODU cellular network mode. |
| `ROUTER_URL` | Router address, normally `https://192.168.100.1` for FiberX or `https://192.168.1.1` for the Airtel ODU. |
| `ROUTER_USERNAME` | Router web-interface username. |
| `ROUTER_PASSWORD` | Router web-interface password. |
| `USAGE_TIMEZONE` | Timezone used to decide when a usage day starts and ends. |
| `PORT` | Local dashboard port. The default is `3000`. |
| `ROUTER_TLS_FINGERPRINT256` | Optional verified SHA-256 certificate fingerprint for a self-signed HTTPS router certificate. |

Keep `ROUTER_INSECURE_TLS=false` and `ROUTER_ALLOW_PLAINTEXT_HTTP=false` whenever possible. Do not use the router password as the dashboard password.

### Airtel ODU configuration

When the computer is connected to the Airtel ODU, use the ODU's HTTPS dashboard address and credentials:

```dotenv
ROUTER_SOURCE=auto
ROUTER_URL=https://192.168.1.1
ROUTER_USERNAME=root
ROUTER_PASSWORD=your-odu-dashboard-password
ROUTER_INSECURE_TLS=false
ROUTER_TLS_FINGERPRINT256=verified-odu-certificate-fingerprint
```

The ZLT integration authenticates to the ODU command API and reads its monthly traffic total. `auto` detects this integration before falling back to the Huawei integration. If you prefer a fixed selection, use `ROUTER_SOURCE=zlt`.

This setting does not change the ODU's cellular network selection. The ODU dashboard controls that separately. If its current mode is `5G NSA Only`, selecting the ODU's `Auto` radio mode is a separate change and may reconnect the link. FiberX only reads traffic data and does not alter the radio setting.

### Check the configuration

Run:

```sh
node server.js --check-config
```

This checks the local settings without opening the dashboard port or contacting the router. Fix any reported setting before starting the app.

## 2. Start and sign in

Start the local server:

```sh
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser. If you changed `PORT`, use that port instead.

The sign-in page asks for `DASHBOARD_PASSWORD`, not the router password. FiberX creates a protected local session after sign-in. The password is not stored in the browser.

![FiberX sign-in screen](images/fiberx-login.png)

## 3. Read the dashboard

![FiberX dashboard](images/fiberx-dashboard.png)

### Top controls

- **Month selector** changes the month shown in the cards and chart. It reads saved local history and does not create a new router sample.
- **Sync Router** requests a fresh router sample immediately.
- **Export CSV** downloads the selected month's daily history as a CSV file.

The background collector samples every 30 seconds while the server is running. The browser page is only a view of the saved local history.

### Summary cards

- **Total usage this month** is the sum of the saved daily usage rows for the selected month.
- **Latest day usage** is the most recently recorded day in that month.
- **Daily average** is the average of the recorded daily rows.
- **Plan status / pace** shows whether the saved plan is unlimited or capped.
- **Projected month end** estimates the month total using the current average. It is a pace estimate, not a bill or a router value.

The first successful sample establishes the baseline for the cumulative router counters. It is normal for the first sync to show no usage. A second sample on the same day updates the day total; the chart becomes more useful after usage has been recorded across multiple days.

### Plan settings

1. Select **Unlimited (ODU / FiberX)** or **Capped plan**.
2. If the plan is capped, enter the monthly cap in GB.
3. Enter the billing-cycle start day from 1 to 28.
4. Select **Save settings**.

These settings change how FiberX presents pace and progress. They do not change the router plan or contact MTN.

### Router telemetry

The telemetry panel shows:

- the cumulative RX/download counter;
- the cumulative TX/upload counter;
- the last successful router sync; and
- the baseline used to calculate deltas.

The counters are source values from the router. They are not the same as the daily usage total, which is calculated from the changes between samples. On the ODU, the source reports a monthly total; FiberX delta-tracks that value and resets the comparison baseline when the configured router source changes.

### Connected devices

The device table can show a device name or address, connection type, connection duration, negotiated RX/TX link rates, and signal strength. Link rates describe the Wi-Fi connection between the device and router; they are not current internet speed.

Per-device usage is shown only when the router firmware exposes per-device byte counters. The tested HG8145X7-10 response does not expose those counters, so `Not exposed` is expected. The WAN usage total still works.

## 4. Keep collection running

Closing the browser does not stop collection. The Node server must remain running.

For a foreground run, leave this command open:

```sh
node server.js
```

On macOS, install the included background service instead:

```sh
./start-fiberx.sh
```

The launcher starts FiberX at login and restarts it if it exits. Its logs are in:

- `~/Library/Logs/FiberX/server.log`
- `~/Library/Logs/FiberX/server-error.log`

### Optional menu-bar companion

If you want FiberX available from the macOS menu bar, install the collector and then run:

```sh
./start-fiberx.sh
./macos/install-menubar-app.sh
```

The menu-bar icon opens a compact native dropdown with total usage this month, today's usage, recent download/upload speed, daily average, projected month-end usage, plan status, router status, and last sync time. The full dashboard remains an optional menu action rather than a requirement for routine checks. The companion can also restart the collection service and open the log directory. It starts at login through a per-user LaunchAgent.

The companion is compiled locally with macOS's Swift compiler and ad-hoc signed. A paid Apple Developer Program membership is not required for this personal/local setup. Because it is not notarized, macOS may ask you to control-click `~/Applications/FiberX.app`, choose **Open**, and confirm on first launch. This build is not suitable for App Store distribution.

Remove the companion without removing FiberX data or the collector:

```sh
./macos/uninstall-menubar-app.sh
```

If the computer sleeps, shuts down, or loses access to the router, the collector cannot sample during that period. When it reconnects, FiberX records the next available interval. If the router reset its counters during the gap, the missing usage cannot be calculated reliably.

## 5. Where data is stored

FiberX keeps its local state in the project directory's `data/` folder:

- `fiberx.sqlite` is the primary store when the built-in SQLite API is available.
- `usage.json` is retained as a fallback or migration source.
- SQLite sidecar and backup files may also be present.

The files are local, ignored by Git, and restricted to the current OS account. Back up the data directory privately if you need to preserve history. Do not upload it to an issue or commit it to a public repository.

## 6. Troubleshooting

| Problem | What to try |
| --- | --- |
| The server refuses to start because of Node.js | Install or select Node.js `24.18.1+` within the 24.x line, then run the command again. |
| The sign-in page rejects the password | Use the value in `DASHBOARD_PASSWORD`. It is different from `ROUTER_PASSWORD`. |
| Router login is rejected | Check `ROUTER_URL`, `ROUTER_USERNAME`, and `ROUTER_PASSWORD`. If the router has a temporary login lockout, wait for it to clear before trying again. |
| Airtel ODU is not detected | Confirm the computer is connected to the ODU, use `https://192.168.1.1`, keep `ROUTER_SOURCE=auto` or set `ROUTER_SOURCE=zlt`, and verify the ODU dashboard credentials. |
| HTTPS or certificate errors appear | Use a verified value for `ROUTER_TLS_FINGERPRINT256` when the router uses a self-signed certificate. Avoid disabling TLS verification. |
| ODU radio mode is wrong | Change the cellular network selection in the ODU dashboard. `ROUTER_SOURCE=auto` only selects the FiberX integration and does not mean cellular radio Auto. |
| The first sync shows zero usage | This is expected: the first sample establishes a baseline. Keep the server running for later samples. |
| The chart is empty | Make sure the server has recorded usage on at least one or more days, then refresh the dashboard. |
| Usage appears lower after a router restart | The router may have reset its cumulative counters. FiberX starts a new interval rather than recording a negative value. |
| The macOS launcher reports that the port is busy | Stop the other process using the configured port, then run `./start-fiberx.sh` again. The launcher does not kill unrelated processes. |

## 7. Privacy reminders

FiberX is designed to stay on the local machine, but the files and screenshots can still contain sensitive information. Before sharing anything publicly:

- remove `.env`, `data/`, CSV exports, and LaunchAgent logs;
- remove device names, IP addresses, and MAC addresses from screenshots;
- never paste router responses or passwords into an issue; and
- rotate a credential immediately if it was committed or shared.

See [SECURITY.md](../SECURITY.md) for private vulnerability reporting and the project's security model.

## 8. For contributors

Run the lightweight syntax check before opening a pull request:

```sh
npm run check
```

Keep the application dependency-free unless a new dependency is necessary, and keep local credentials and telemetry out of commits.
