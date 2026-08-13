# MTN FiberX Data Tracker

This is a localhost dashboard that recreates the dark MTN usage view from the reference image and backs it with the Huawei HG8145X7-10 WAN counters exposed by the MTN FiberX router.

## How it works

The router does not expose a ready-made monthly usage history. Its embedded UI exposes cumulative WAN statistics instead:

- `/html/bbsp/common/get_wan_list_ipwanstat.asp`
- `/html/bbsp/common/get_wan_list_pppwanstat.asp`

The local Node server logs into the router, reads RX/TX bytes, calculates the delta since the previous sample, and stores the sample in `data/usage.json`. The browser only talks to `127.0.0.1`, so the router password is never sent to the browser or committed to this project.

The first sync establishes a baseline and records zero usage. Leave the server running so the 30-second polling interval can build the daily chart.

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

## Notes

- This tracks the cumulative WAN PPP/IP counters, so it cannot reconstruct days from before the first baseline.
- If the router reboots or resets its counters, the next sample is treated as a new interval instead of creating a negative number.
- Plan settings and history are local to this checkout. Generated history is ignored by Git.
- Use the dashboard's Export CSV button to export the selected month.

