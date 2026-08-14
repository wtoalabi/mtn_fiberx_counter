# Security Policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch. FiberX requires a patched Node.js 24 LTS runtime, currently Node.js 24.18.1 or newer within the 24.x line. Older and end-of-life Node.js releases are unsupported.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, screenshot, or log attachment.

Use GitHub's [private vulnerability reporting form](https://github.com/wtoalabi/mtn_fiberx_counter/security/advisories/new). Include:

- the affected commit or release;
- a minimal reproduction and realistic impact;
- whether the issue requires a malicious website, local OS account, router response, or network position;
- any credential, device-history, or filesystem exposure; and
- a suggested mitigation, if known.

If private vulnerability reporting is unavailable, contact the maintainer through their GitHub profile to request a private channel without including exploit details in the initial message. Reports will be validated privately before a coordinated fix and disclosure.

## Security model

FiberX treats browser content, router responses, DNS answers, and other local OS accounts as untrusted. The service:

- binds only to `127.0.0.1` and validates the exact loopback authority;
- requires high-entropy HTTP Basic authentication for every data-bearing route;
- keeps GET requests read-only and applies same-origin protections to API calls;
- constrains router connections to private, loopback, and link-local addresses;
- verifies router TLS certificates, supports certificate pinning for self-signed routers, and requires explicit opt-ins for unverified TLS or plaintext HTTP;
- bounds HTTP bodies, headers, router responses, cookies, and parser work; and
- stores credentials and device history in owner-only, non-symlinked local files.

The checked-out application code, the current OS account, and administrators of the machine remain trusted. A process already running as the same OS user can read that user's files and is outside the application's isolation boundary. A privileged local compromise is also outside scope.

## Sensitive diagnostic material

Never attach `.env`, `data/`, `dashboard-password`, LaunchAgent logs, router response bodies, exported CSV files, or screenshots containing device names, IP addresses, or MAC addresses to a public report. If a secret was committed or shared, rotate it immediately; deleting the current file is not enough when it remains in Git history or an external archive.
