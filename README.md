# MTN FiberX Data Tracker

This is a localhost dashboard that recreates the dark MTN usage view from the reference image and backs it with the Huawei HG8145X7-10 WAN counters exposed by the MTN FiberX router.

## How it works

The router does not expose a ready-made monthly usage history. Its embedded UI exposes cumulative WAN statistics instead:

- `/html/bbsp/common/get_wan_list_ipwanstat.asp`
- `/html/bbsp/common/get_wan_list_pppwanstat.asp`

The local Node server logs into the router, reads RX/TX bytes, calculates the delta since the previous sample, and stores the sample in `data/usage.json`. The browser only talks to `127.0.0.1`, so the router password is never sent to the browser or committed to this project.

The first sync establishes a baseline and records zero usage. Leave the server running so the 30-second polling interval can build the daily chart.

The dashboard also checks the Huawei connected-client resources and displays the device name/host, IP or MAC address, SSID, connection duration, negotiated RX/TX Wi-Fi link rates, and signal strength when the firmware returns them. These are link rates, not current internet throughput. This HG8145X7-10 UI exposes per-station rates but does not expose a reliable per-station monthly byte history in the responses inspected, so the device table marks byte usage as unavailable when appropriate.

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

If the dashboard reports that the router reset the connection, stop the server, wait for the Huawei login lockout timer to clear, verify that `ROUTER_PASSWORD` in `.env` matches the current router password, and start the server again. The collector pauses repeated login attempts after a failure so a wrong password does not continuously lock the router.

## Notes

- This tracks the cumulative WAN PPP/IP counters, so it cannot reconstruct days from before the first baseline.
- If the router reboots or resets its counters, the next sample is treated as a new interval instead of creating a negative number.
- Plan settings and history are local to this checkout. Generated history is ignored by Git.
- Use the dashboard's Export CSV button to export the selected month.
