"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const fsPromises = fs.promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");
let DatabaseSync = null;

if (process.platform !== "win32") {
  process.umask(0o077);
}

try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  DatabaseSync = null;
}

const ROOT_DIRECTORY = __dirname;
const DATA_DIRECTORY = path.join(ROOT_DIRECTORY, "data");
const ENVIRONMENT_FILE = path.join(ROOT_DIRECTORY, ".env");
const DATABASE_FILE = path.join(DATA_DIRECTORY, "fiberx.sqlite");
const DASHBOARD_PASSWORD_FILE = path.join(DATA_DIRECTORY, "dashboard-password");
const JSON_DATA_FILE = path.join(DATA_DIRECTORY, "usage.json");
const ALLOWED_DOT_ENV_KEYS = new Set([
  "DASHBOARD_PASSWORD",
  "DASHBOARD_USERNAME",
  "PORT",
  "ROUTER_ALLOW_PLAINTEXT_HTTP",
  "ROUTER_INSECURE_TLS",
  "ROUTER_PASSWORD",
  "ROUTER_TLS_FINGERPRINT256",
  "ROUTER_URL",
  "ROUTER_USERNAME",
  "USAGE_TIMEZONE",
]);
const STORE_VERSION = 5;
const DATABASE_SCHEMA_VERSION = 2;
const MINIMUM_NODE_VERSION = Object.freeze([24, 18, 1]);
const MAX_COUNTER_DIGITS = 128;
const MAX_DEVICE_FIELD_LENGTH = 128;
const MAX_DEVICE_IDENTITIES_PER_MONTH = 2_048;
const MAX_DEVICE_RECORDS = 512;
const MAX_JSON_NODES = 10_000;
const MAX_REQUEST_BODY_BYTES = 16_384;
const MAX_REQUEST_URL_BYTES = 2_048;
const MAX_ROUTER_BODY_BYTES = 2 * 1_024 * 1_024;
const MAX_ROUTER_COOKIES = 64;
const MAX_ROUTER_COOKIE_BYTES = 8_192;
const MAX_WAN_RECORDS = 128;
const PRIVATE_NETWORKS = new net.BlockList();
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; trusted-types 'none'; require-trusted-types-for 'script'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
});

PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addAddress("::1", "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORKS.addSubnet("fe80::", 10, "ipv6");
const WAN_STATS_ENDPOINTS = [
  "/html/bbsp/common/get_wan_list_ipwanstat.asp",
  "/html/bbsp/common/get_wan_list_pppwanstat.asp",
  "/html/bbsp/common/wanStatsinfo.asp",
  "/html/AllUsers/html/bbsp/common/wanStatsinfo.asp",
];
const DEVICE_ENDPOINT_GROUPS = [
  {
    name: "LAN/WLAN device list",
    paths: [
      "/html/bbsp/common/GetLanUserDevInfo.asp",
      "/html/bbsp/common/GetLanUserDhcpInfo.asp",
      "/html/bbsp/common/lanuserinfo.asp",
      "/html/bbsp/common/dhcpinfo.asp",
    ],
  },
  {
    name: "WLAN station rates",
    paths: [
      "/html/AllUsers/html/amp/wlaninfo/getassociateddeviceinfo.asp",
      "/html/amp/wlaninfo/getassociateddeviceinfo.asp",
      "/html/bbsp/status/wlaninfo.asp",
      "/html/status/wlaninfo.asp",
    ],
  },
];
const COLLECTION_INTERVAL_MS = 30_000;
const KNOWN_DEVICE_CONSTRUCTOR_DEFINITIONS = {
  /**
   * The associated-device endpoint omits this constructor's function
   * declaration, so its stable Huawei field order is kept as a parser fallback.
   */
  stAssociatedDevice: [
    "domain",
    "AssociatedDeviceMACAddress",
    "X_HW_Uptime",
    "X_HW_RxRate",
    "X_HW_TxRate",
    "X_HW_RSSI",
    "X_HW_Noise",
    "X_HW_SNR",
    "X_HW_SingalQuality",
    "X_HW_WorkingMode",
    "X_HW_WMMStatus",
    "X_HW_PSMode",
    "X_HW_HighBandFlag",
    "AssociatedDeviceIPAddress",
    "HW_AssociatedDevicedescriptions",
    "X_HW_AntennaNum",
    "X_HW_11kSupported",
    "X_HW_11vSupported",
    "X_HW_DualBandSupported",
    "X_HW_BeamFormingSupported",
    "X_HW_11RSupported",
    "X_HW_IsMultilink",
  ],
};
const routerSession = {
  cookies: new Map(),
  loggedIn: false,
  authBlockedUntil: 0,
};
let cachedConfig = null;
let collectionPromise = null;
let persistenceQueue = Promise.resolve();
let storeMutationQueue = Promise.resolve();
let sqliteDatabase = null;
let storageBackend = null;
let backgroundCollectionTimer = null;
let lastBackgroundCollectionError = null;

/**
 * Compares the running Node.js release with the security baseline documented by
 * this repository. FiberX supports the current 24.x LTS line only so an EOL or
 * pre-security-release runtime cannot silently host the local HTTP service.
 *
 * @returns {void}
 */
function assertSupportedNodeRuntime() {
  const versionParts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const [requiredMajor, requiredMinor, requiredPatch] = MINIMUM_NODE_VERSION;
  const [major, minor, patchVersion] = versionParts;
  const meetsMinimum = major === requiredMajor && (
    minor > requiredMinor || (minor === requiredMinor && patchVersion >= requiredPatch)
  );
  if (!meetsMinimum) {
    throw new Error(`FiberX requires a patched Node.js 24 LTS release (v${MINIMUM_NODE_VERSION.join(".")} or newer within 24.x). Running: v${process.versions.node}.`);
  }
}

/**
 * Creates a distinguishable error for a local path that could redirect
 * credential or telemetry access through a symbolic link. Storage fallback
 * must not swallow these errors because doing so would weaken the path check.
 *
 * @param {string} message Actionable description of the unsafe path.
 * @returns {Error & {code:string}} A security-specific local path error.
 */
function createUnsafePathError(message) {
  const error = new Error(message);
  error.code = "ERR_FIBERX_UNSAFE_PATH";
  return error;
}

/**
 * Verifies that an existing sensitive path has the expected type, refuses
 * symbolic links, and removes group/other access on POSIX systems. The app's
 * router credentials and device history are private to the current OS user.
 *
 * @param {string} filePath Absolute path to inspect.
 * @param {"file"|"directory"} expectedType Required filesystem object type.
 * @returns {void}
 */
function hardenPrivatePath(filePath, expectedType) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw createUnsafePathError(`Refusing to use symbolic link at ${filePath}.`);
  }
  if (expectedType === "directory" && !stats.isDirectory()) {
    throw createUnsafePathError(`Expected a private directory at ${filePath}.`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    throw createUnsafePathError(`Expected a private regular file at ${filePath}.`);
  }

  if (process.platform !== "win32") {
    fs.chmodSync(filePath, expectedType === "directory" ? 0o700 : 0o600);
  }
}

/**
 * Creates and secures the local data directory before either persistence
 * backend opens a file. Existing database sidecars are tightened as well so an
 * upgrade repairs permissions inherited from an older, permissive umask.
 *
 * @returns {void}
 */
function preparePrivateStorage() {
  if (fs.existsSync(DATA_DIRECTORY)) {
    hardenPrivatePath(DATA_DIRECTORY, "directory");
  } else {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
  }

  [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, DASHBOARD_PASSWORD_FILE, JSON_DATA_FILE]
    .forEach((filePath) => hardenPrivatePath(filePath, "file"));
}

/**
 * Loads simple KEY=VALUE pairs from an optional local .env file without adding
 * a package dependency. Existing process environment variables always win, so
 * deployment shells and launch agents can provide the authoritative values.
 *
 * @param {string} filePath Absolute path to the optional environment file.
 * @returns {void}
 */
function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  hardenPrivatePath(filePath, "file");
  const contents = fs.readFileSync(filePath, "utf8");
  contents.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new Error(`Invalid .env entry on line ${lineIndex + 1}. Expected KEY=VALUE.`);
    }

    const key = trimmed.slice(0, separator).trim();
    if (!ALLOWED_DOT_ENV_KEYS.has(key)) {
      throw new Error(`Unsupported .env key on line ${lineIndex + 1}: ${key}.`);
    }
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

/**
 * Parses one strict boolean environment value. Only literal true/false values
 * are accepted so a typo can never silently disable TLS verification.
 *
 * @param {string} name Environment variable name.
 * @param {boolean} defaultValue Value used when the variable is absent.
 * @returns {boolean} The validated boolean value.
 */
function parseBooleanEnvironment(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue === "undefined" || rawValue === "") {
    return defaultValue;
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${name} must be either true or false.`);
}

/**
 * Parses the configured router origin without permitting URL credentials,
 * query strings, fragments, or non-HTTP protocols. Keeping credentials in
 * dedicated variables prevents them from appearing in logs and URL errors.
 *
 * @param {string|undefined} rawValue Configured router URL.
 * @returns {URL} A normalized HTTP(S) router origin.
 */
function parseRouterUrl(rawValue) {
  const routerUrl = new URL(rawValue || "https://192.168.100.1");
  if (routerUrl.protocol !== "http:" && routerUrl.protocol !== "https:") {
    throw new Error("ROUTER_URL must use http:// or https://.");
  }
  if (routerUrl.username || routerUrl.password) {
    throw new Error("ROUTER_URL must not contain credentials; use ROUTER_USERNAME and ROUTER_PASSWORD.");
  }
  if (routerUrl.search || routerUrl.hash || (routerUrl.pathname && routerUrl.pathname !== "/")) {
    throw new Error("ROUTER_URL must contain only the router origin, without a path, query, or fragment.");
  }

  const hostname = routerUrl.hostname.replace(/^\[|\]$/g, "");
  const addressFamily = net.isIP(hostname);
  if (addressFamily && !isPrivateRouterAddress(hostname, addressFamily)) {
    throw new Error("ROUTER_URL must resolve to a private, loopback, or link-local address.");
  }

  routerUrl.pathname = "/";
  return routerUrl;
}

/**
 * Determines whether one resolved IP belongs to a network range appropriate
 * for a local router. Public, unspecified, multicast, and IPv4-mapped IPv6
 * addresses are rejected to prevent credential exfiltration through SSRF.
 *
 * @param {string} address Resolved IPv4 or IPv6 address.
 * @param {number|string} family Address family reported by Node.js.
 * @returns {boolean} Whether the address is an allowed local-network target.
 */
function isPrivateRouterAddress(address, family) {
  const normalizedAddress = String(address || "").replace(/^\[|\]$/g, "").split("%")[0];
  const normalizedFamily = family === 6 || family === "IPv6" ? "ipv6" : "ipv4";
  if (normalizedAddress.toLowerCase().startsWith("::ffff:")) {
    return false;
  }

  return PRIVATE_NETWORKS.check(normalizedAddress, normalizedFamily);
}

/**
 * Resolves a router hostname and returns only private-network results to the
 * HTTP client. Supplying the selected address through Node's lookup callback
 * closes the DNS rebinding window between validation and socket connection.
 *
 * @param {string} hostname Router hostname requested by the HTTP client.
 * @param {object|number} options Node.js DNS lookup options.
 * @param {Function} callback Node.js lookup completion callback.
 * @returns {void}
 */
function lookupPrivateRouterAddress(hostname, options, callback) {
  const lookupOptions = typeof options === "number" ? { family: options } : { ...(options || {}) };
  const requestedFamily = lookupOptions.family === 6 || lookupOptions.family === "IPv6"
    ? 6
    : lookupOptions.family === 4 || lookupOptions.family === "IPv4" ? 4 : 0;

  dns.lookup(hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }

    const permitted = addresses.filter((entry) => (
      (!requestedFamily || entry.family === requestedFamily)
      && isPrivateRouterAddress(entry.address, entry.family)
    ));
    if (permitted.length === 0) {
      const lookupError = new Error("ROUTER_URL did not resolve to an allowed private-network address.");
      lookupError.code = "ERR_FIBERX_PUBLIC_ROUTER_TARGET";
      callback(lookupError);
      return;
    }

    if (lookupOptions.all) {
      callback(null, permitted);
      return;
    }
    callback(null, permitted[0].address, permitted[0].family);
  });
}

/**
 * Validates that an IANA timezone identifier can be used for billing calendar
 * keys before the background collector starts writing samples.
 *
 * @param {string} timezone Configured IANA timezone identifier.
 * @returns {string} The validated identifier.
 */
function validateUsageTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch (error) {
    throw new Error(`USAGE_TIMEZONE is not a valid IANA timezone: ${timezone}.`);
  }

  return timezone;
}

/**
 * Normalizes an optional SHA-256 certificate fingerprint used to authenticate
 * a self-signed router certificate. Colons and ASCII whitespace are accepted
 * for compatibility with browser and OpenSSL fingerprint displays.
 *
 * @param {string|undefined} rawValue Configured leaf-certificate fingerprint.
 * @returns {string|null} Uppercase 64-character hex digest, or null when absent.
 */
function parseTlsFingerprint(rawValue) {
  if (!rawValue) {
    return null;
  }

  const fingerprint = String(rawValue).replace(/[:\s]/g, "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(fingerprint)) {
    throw new Error("ROUTER_TLS_FINGERPRINT256 must be a SHA-256 certificate fingerprint.");
  }
  return fingerprint;
}

/**
 * Loads an operator-supplied dashboard password or creates a high-entropy local
 * password on first launch. The generated secret is stored outside Git with
 * owner-only permissions and can be rotated by deleting the file while FiberX
 * is stopped. Concurrent first starts safely converge on the same file.
 *
 * @returns {string} Dashboard password used for HTTP Basic authentication.
 */
function getDashboardPassword() {
  const configuredPassword = process.env.DASHBOARD_PASSWORD || "";
  if (configuredPassword) {
    return configuredPassword;
  }

  preparePrivateStorage();
  if (!fs.existsSync(DASHBOARD_PASSWORD_FILE)) {
    const generatedPassword = crypto.randomBytes(32).toString("base64url");
    try {
      fs.writeFileSync(DASHBOARD_PASSWORD_FILE, `${generatedPassword}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      console.log(`Dashboard password created at ${DASHBOARD_PASSWORD_FILE}.`);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  hardenPrivatePath(DASHBOARD_PASSWORD_FILE, "file");
  return fs.readFileSync(DASHBOARD_PASSWORD_FILE, "utf8").trim();
}

/**
 * Reads and validates runtime configuration while deliberately excluding the
 * router password from any object that is logged or returned to the browser.
 *
 * @returns {{port:number,host:string,dashboardUsername:string,dashboardPassword:string,routerUrl:URL,routerUsername:string,routerPassword:string,allowInsecureTls:boolean,allowPlaintextHttp:boolean,routerTlsFingerprint:string|null,usageTimezone:string,collectionIntervalMs:number}} Runtime configuration.
 */
function getConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  loadDotEnvFile(ENVIRONMENT_FILE);
  const routerUrl = parseRouterUrl(process.env.ROUTER_URL);
  const configuredPort = Number.parseInt(process.env.PORT || "3000", 10);
  const dashboardUsername = process.env.DASHBOARD_USERNAME || "fiberx";
  const dashboardPassword = getDashboardPassword();
  const routerUsername = process.env.ROUTER_USERNAME || "root";
  const routerPassword = process.env.ROUTER_PASSWORD || "";
  const usageTimezone = process.env.USAGE_TIMEZONE || "Africa/Lagos";
  const allowInsecureTls = parseBooleanEnvironment("ROUTER_INSECURE_TLS", false);
  const allowPlaintextHttp = parseBooleanEnvironment("ROUTER_ALLOW_PLAINTEXT_HTTP", false);
  const routerTlsFingerprint = parseTlsFingerprint(process.env.ROUTER_TLS_FINGERPRINT256);

  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535
    || String(configuredPort) !== String(process.env.PORT || "3000")) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (!routerUsername || routerUsername.length > 256) {
    throw new Error("ROUTER_USERNAME must contain between 1 and 256 characters.");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dashboardUsername)) {
    throw new Error("DASHBOARD_USERNAME must contain 1-64 letters, numbers, dots, underscores, or hyphens.");
  }
  if (dashboardPassword.length < 20 || dashboardPassword.length > 256) {
    throw new Error("DASHBOARD_PASSWORD must contain between 20 and 256 characters.");
  }
  if (routerPassword.length > 1_024) {
    throw new Error("ROUTER_PASSWORD must not exceed 1024 characters.");
  }
  if (routerPassword && dashboardPassword === routerPassword) {
    throw new Error("DASHBOARD_PASSWORD must not reuse ROUTER_PASSWORD.");
  }
  if (routerUrl.protocol === "http:" && !allowPlaintextHttp) {
    throw new Error("ROUTER_URL uses plaintext HTTP. Set ROUTER_ALLOW_PLAINTEXT_HTTP=true only if this risk is unavoidable.");
  }
  if (routerUrl.protocol !== "https:" && routerTlsFingerprint) {
    throw new Error("ROUTER_TLS_FINGERPRINT256 can be used only with an https:// ROUTER_URL.");
  }
  if (allowInsecureTls && routerTlsFingerprint) {
    throw new Error("Use either ROUTER_TLS_FINGERPRINT256 or ROUTER_INSECURE_TLS=true, not both.");
  }

  cachedConfig = {
    port: configuredPort,
    host: "127.0.0.1",
    dashboardUsername,
    dashboardPassword,
    routerUrl,
    routerUsername,
    routerPassword,
    allowInsecureTls,
    allowPlaintextHttp,
    routerTlsFingerprint,
    usageTimezone: validateUsageTimezone(usageTimezone),
    collectionIntervalMs: COLLECTION_INTERVAL_MS,
  };

  return cachedConfig;
}

/**
 * Creates the initial persisted shape used before the first router sample.
 *
 * @returns {object} An empty usage store with safe default plan settings.
 */
function createEmptyStore() {
  return {
    version: STORE_VERSION,
    settings: {
      planMode: "unlimited",
      capGb: 500,
      billingStartDay: 1,
    },
    baseline: null,
    lastCounters: null,
    lastRouter: null,
    lastDevices: null,
    lastOfflineGap: null,
    deviceUsageSamples: [],
    samples: [],
  };
}

/**
 * Normalizes a persisted store so a partially created or older local file does
 * not crash the dashboard after a process restart.
 *
 * @param {object|null|undefined} candidate Parsed persisted data.
 * @returns {object} A store containing all required fields.
 */
function normalizeStore(candidate) {
  const empty = createEmptyStore();
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const settings = source.settings && typeof source.settings === "object" ? source.settings : {};

  return {
    version: STORE_VERSION,
    settings: {
      planMode: settings.planMode === "capped" ? "capped" : empty.settings.planMode,
      capGb: Number.isFinite(Number(settings.capGb)) && Number(settings.capGb) > 0 ? Number(settings.capGb) : empty.settings.capGb,
      billingStartDay: Number.isFinite(Number(settings.billingStartDay)) ? Math.min(28, Math.max(1, Number(settings.billingStartDay))) : empty.settings.billingStartDay,
    },
    baseline: source.baseline && typeof source.baseline === "object" ? source.baseline : null,
    lastCounters: source.lastCounters && typeof source.lastCounters === "object" ? source.lastCounters : null,
    lastRouter: source.lastRouter && typeof source.lastRouter === "object" ? source.lastRouter : null,
    lastDevices: source.lastDevices && typeof source.lastDevices === "object" ? source.lastDevices : null,
    lastOfflineGap: source.lastOfflineGap && typeof source.lastOfflineGap === "object" ? source.lastOfflineGap : null,
    deviceUsageSamples: compactDeviceUsageSamples(Array.isArray(source.deviceUsageSamples) ? source.deviceUsageSamples : []),
    samples: compactUsageSamples(Array.isArray(source.samples) ? source.samples : []),
  };
}

/**
 * Normalizes a persisted non-negative count without allowing malformed or
 * excessively large numeric values to poison summary arithmetic.
 *
 * @param {unknown} value Persisted count value.
 * @param {number} fallback Value used when the input is invalid.
 * @returns {number} A bounded non-negative integer.
 */
function normalizePersistedCount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Compacts interval-level WAN rows into one exact daily aggregate. Latest
 * cumulative counters are retained, interval deltas are summed with BigInt,
 * and poll counts remain available for CSV diagnostics.
 *
 * @param {object[]} samples Persisted WAN interval or aggregate rows.
 * @returns {object[]} Chronological daily WAN aggregates.
 */
function compactUsageSamples(samples) {
  const dailySamples = new Map();
  samples.forEach((sample) => {
    const day = String(sample?.day || "");
    const capturedAt = String(sample?.capturedAt || "");
    if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(day)
      || !Number.isFinite(Date.parse(capturedAt))) {
      return;
    }

    const existing = dailySamples.get(day);
    const pollCount = Math.max(1, normalizePersistedCount(sample.pollCount, 1));
    const routerRecordCount = normalizePersistedCount(sample.sampleCount, 0);
    if (!existing) {
      dailySamples.set(day, {
        capturedAt,
        day,
        month: day.slice(0, 7),
        rxBytes: normalizeCounter(sample.rxBytes),
        txBytes: normalizeCounter(sample.txBytes),
        rxDeltaBytes: normalizeCounter(sample.rxDeltaBytes),
        txDeltaBytes: normalizeCounter(sample.txDeltaBytes),
        usageBytes: normalizeCounter(sample.usageBytes),
        counterReset: Boolean(sample.counterReset),
        offlineGap: sample.offlineGap && typeof sample.offlineGap === "object" ? sample.offlineGap : null,
        sampleCount: routerRecordCount,
        pollCount,
      });
      return;
    }

    existing.rxDeltaBytes = addCounterStrings(existing.rxDeltaBytes, sample.rxDeltaBytes);
    existing.txDeltaBytes = addCounterStrings(existing.txDeltaBytes, sample.txDeltaBytes);
    existing.usageBytes = addCounterStrings(existing.usageBytes, sample.usageBytes);
    existing.counterReset = existing.counterReset || Boolean(sample.counterReset);
    existing.sampleCount = Math.min(Number.MAX_SAFE_INTEGER, existing.sampleCount + routerRecordCount);
    existing.pollCount = Math.min(Number.MAX_SAFE_INTEGER, existing.pollCount + pollCount);
    if (capturedAt >= existing.capturedAt) {
      existing.capturedAt = capturedAt;
      existing.rxBytes = normalizeCounter(sample.rxBytes);
      existing.txBytes = normalizeCounter(sample.txBytes);
      existing.offlineGap = sample.offlineGap && typeof sample.offlineGap === "object"
        ? sample.offlineGap
        : existing.offlineGap;
    }
  });

  return Array.from(dailySamples.values()).sort((first, second) => first.day.localeCompare(second.day));
}

/**
 * Compacts interval-level device rows into one exact monthly row per stable
 * device identity. A hard identity ceiling prevents a compromised router from
 * exhausting local storage by rotating fabricated identifiers on every poll.
 * When the ceiling is reached, established devices with the most observations
 * win deterministically. WAN totals remain exact and independent of this cap.
 *
 * @param {object[]} samples Persisted device interval or aggregate rows.
 * @returns {object[]} Chronological per-device monthly aggregates.
 */
function compactDeviceUsageSamples(samples) {
  const monthlySamples = new Map();
  samples.forEach((sample) => {
    const day = String(sample?.day || "");
    const capturedAt = String(sample?.capturedAt || "");
    const deviceId = String(sample?.deviceId || "").slice(0, MAX_DEVICE_FIELD_LENGTH);
    if (!deviceId
      || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(day)
      || !Number.isFinite(Date.parse(capturedAt))) {
      return;
    }

    const month = day.slice(0, 7);
    const key = `${month}\0${deviceId}`;
    const existing = monthlySamples.get(key);
    const pollCount = Math.max(1, normalizePersistedCount(sample.pollCount, 1));
    if (!existing) {
      monthlySamples.set(key, {
        capturedAt,
        day,
        month,
        deviceId,
        name: sample.name ? String(sample.name).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
        mac: sample.mac ? String(sample.mac).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
        ip: sample.ip ? String(sample.ip).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
        rxDeltaBytes: normalizeCounter(sample.rxDeltaBytes),
        txDeltaBytes: normalizeCounter(sample.txDeltaBytes),
        usageBytes: normalizeCounter(sample.usageBytes),
        counterReset: Boolean(sample.counterReset),
        baseline: Boolean(sample.baseline),
        pollCount,
      });
      return;
    }

    existing.rxDeltaBytes = addCounterStrings(existing.rxDeltaBytes, sample.rxDeltaBytes);
    existing.txDeltaBytes = addCounterStrings(existing.txDeltaBytes, sample.txDeltaBytes);
    existing.usageBytes = addCounterStrings(existing.usageBytes, sample.usageBytes);
    existing.counterReset = existing.counterReset || Boolean(sample.counterReset);
    existing.baseline = existing.baseline && Boolean(sample.baseline);
    existing.pollCount = Math.min(Number.MAX_SAFE_INTEGER, existing.pollCount + pollCount);
    if (capturedAt >= existing.capturedAt) {
      existing.capturedAt = capturedAt;
      existing.day = day;
      existing.name = sample.name ? String(sample.name).slice(0, MAX_DEVICE_FIELD_LENGTH) : existing.name;
      existing.mac = sample.mac ? String(sample.mac).slice(0, MAX_DEVICE_FIELD_LENGTH) : existing.mac;
      existing.ip = sample.ip ? String(sample.ip).slice(0, MAX_DEVICE_FIELD_LENGTH) : existing.ip;
    }
  });

  const samplesByMonth = new Map();
  monthlySamples.forEach((sample) => {
    const monthSamples = samplesByMonth.get(sample.month) || [];
    monthSamples.push(sample);
    samplesByMonth.set(sample.month, monthSamples);
  });

  const boundedSamples = [];
  samplesByMonth.forEach((monthSamples) => {
    monthSamples.sort((first, second) => (
      second.pollCount - first.pollCount
      || second.capturedAt.localeCompare(first.capturedAt)
      || first.deviceId.localeCompare(second.deviceId)
    ));
    boundedSamples.push(...monthSamples.slice(0, MAX_DEVICE_IDENTITIES_PER_MONTH));
  });

  return boundedSamples.sort((first, second) => (
    first.month.localeCompare(second.month) || first.deviceId.localeCompare(second.deviceId)
  ));
}

/**
 * Reads the normalized application state from the selected persistence backend.
 * SQLite is preferred when the running Node.js process provides node:sqlite;
 * otherwise the existing JSON store remains the active backend.
 *
 * @returns {Promise<object>} The normalized usage store.
 */
async function readUsageStore() {
  if (getStorageBackend() === "json") {
    return readStoreFromJson();
  }

  return readStoreFromDatabase(getDatabase());
}

/**
 * Serializes persistence writes through a single promise queue. This prevents a
 * manual dashboard sync from interleaving with the background collection while
 * using either the transactional SQLite backend or the atomic JSON fallback.
 *
 * @param {object} store The store to persist.
 * @param {{sample?:object|null,deviceUsageSamples?:object[],deletedDeviceUsageSamples?:object[],replaceHistory?:boolean}} options Incremental or migration write options. JSON persistence ignores the SQLite-only options because the complete store is written.
 * @returns {Promise<void>} Resolves after the queued write completes.
 */
function persistUsageStore(store, options = {}) {
  const operation = persistenceQueue.then(async () => {
    if (getStorageBackend() === "json") {
      await writeStoreToJson(store);
      return;
    }

    writeStoreToDatabase(getDatabase(), store, options);
  });

  persistenceQueue = operation.catch(() => {
    // Keep later writes usable while the caller receives this operation's error.
  });
  return operation;
}

/**
 * Serializes read-modify-write operations that change persisted application
 * state. Persistence writes alone are ordered separately, but this broader
 * queue prevents a router collection holding old settings from overwriting a
 * settings update that completed while the router request was in flight.
 * Failed mutations do not poison later work, while their original callers
 * still receive the rejection.
 *
 * @template T
 * @param {() => Promise<T>} operation Complete asynchronous mutation to run.
 * @returns {Promise<T>} The queued operation result.
 */
function queueStoreMutation(operation) {
  const queuedOperation = storeMutationQueue.then(operation);
  storeMutationQueue = queuedOperation.catch(() => {
    // Preserve queue availability after returning the failure to its caller.
  });
  return queuedOperation;
}

/**
 * Selects SQLite when its built-in Node.js API is available and falls back to
 * the JSON persistence file only when the API itself is unavailable. Database
 * initialization and migration errors fail closed so corruption or a newer
 * schema cannot silently split future samples into another backend.
 *
 * @returns {"sqlite"|"json"} The backend used for this process.
 */
function getStorageBackend() {
  if (storageBackend) {
    return storageBackend;
  }

  if (!DatabaseSync) {
    storageBackend = "json";
    console.warn("FiberX storage: node:sqlite is unavailable; using data/usage.json.");
    return storageBackend;
  }

  getDatabase();
  storageBackend = "sqlite";

  return storageBackend;
}

/**
 * Reads and normalizes the JSON fallback store. A missing file represents a
 * clean first launch, while malformed or unreadable JSON is surfaced so the
 * user does not lose visibility into a damaged local history file.
 *
 * @returns {Promise<object>} The normalized JSON-backed usage store.
 */
async function readStoreFromJson() {
  try {
    hardenPrivatePath(JSON_DATA_FILE, "file");
    const contents = await fsPromises.readFile(JSON_DATA_FILE, "utf8");
    return normalizeStore(JSON.parse(contents));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
    return createEmptyStore();
  }
}

/**
 * Atomically writes the complete JSON fallback store so a restricted runtime
 * can continue collecting data when the built-in SQLite API is unavailable.
 * The existing promise queue prevents concurrent writes from replacing one
 * another out of order.
 *
 * @param {object} store The normalized store to persist.
 * @returns {Promise<void>} Resolves after the JSON file has been replaced.
 */
async function writeStoreToJson(store) {
  preparePrivateStorage();
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  const temporaryFile = path.join(DATA_DIRECTORY, `.usage-${process.pid}-${crypto.randomUUID()}.tmp`);

  try {
    await fsPromises.writeFile(temporaryFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fsPromises.rename(temporaryFile, JSON_DATA_FILE);
    hardenPrivatePath(JSON_DATA_FILE, "file");
  } finally {
    try {
      await fsPromises.unlink(temporaryFile);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

/**
 * Opens and initializes the local SQLite database, including its schema and the
 * one-time import from the previous JSON persistence format.
 *
 * @returns {object} The initialized synchronous SQLite database connection.
 * @throws {Error} When the running Node.js version does not provide node:sqlite
 * or the database cannot be initialized safely.
 */
function getDatabase() {
  if (sqliteDatabase) {
    return sqliteDatabase;
  }
  if (!DatabaseSync) {
    throw new Error("SQLite storage requires Node.js 22.5 or newer with node:sqlite enabled.");
  }

  preparePrivateStorage();
  const database = new DatabaseSync(DATABASE_FILE);

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        plan_mode TEXT NOT NULL,
        cap_gb REAL NOT NULL,
        billing_start_day INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        baseline_json TEXT,
        last_counters_json TEXT,
        last_router_json TEXT,
        last_devices_json TEXT,
        last_offline_gap_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        rx_bytes TEXT NOT NULL,
        tx_bytes TEXT NOT NULL,
        rx_delta_bytes TEXT NOT NULL,
        tx_delta_bytes TEXT NOT NULL,
        usage_bytes TEXT NOT NULL,
        counter_reset INTEGER NOT NULL,
        offline_gap_json TEXT,
        sample_count INTEGER NOT NULL,
        poll_count INTEGER NOT NULL,
        UNIQUE (day)
      );

      CREATE INDEX IF NOT EXISTS usage_samples_month_idx
        ON usage_samples (month, captured_at);

      CREATE TABLE IF NOT EXISTS device_usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        device_id TEXT NOT NULL,
        name TEXT,
        mac TEXT,
        ip TEXT,
        rx_delta_bytes TEXT NOT NULL,
        tx_delta_bytes TEXT NOT NULL,
        usage_bytes TEXT NOT NULL,
        counter_reset INTEGER NOT NULL,
        baseline INTEGER NOT NULL,
        poll_count INTEGER NOT NULL,
        UNIQUE (captured_at, device_id),
        UNIQUE (month, device_id)
      );

      CREATE INDEX IF NOT EXISTS device_usage_samples_month_idx
        ON device_usage_samples (month, device_id, captured_at);
    `);
    database.prepare(`
      INSERT OR IGNORE INTO settings (id, plan_mode, cap_gb, billing_start_day)
      VALUES (1, 'unlimited', 500, 1)
    `).run();
    database.prepare(`
      INSERT OR IGNORE INTO state (
        id, version, baseline_json, last_counters_json, last_router_json,
        last_devices_json, last_offline_gap_json, updated_at
      ) VALUES (1, ?, NULL, NULL, NULL, NULL, NULL, ?)
    `).run(STORE_VERSION, new Date(0).toISOString());
    database.prepare(`
      INSERT OR IGNORE INTO metadata (key, value)
      VALUES ('database_schema_version', ?)
    `).run(String(DATABASE_SCHEMA_VERSION));

    migrateDatabaseSchema(database);
    migrateLegacyJson(database);
    preparePrivateStorage();
    sqliteDatabase = database;
    return sqliteDatabase;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Upgrades an existing database in place before any normal reads or writes.
 * Version 2 compacts historical WAN intervals by day and device intervals by
 * month, preserving exact byte totals while preventing unbounded 30-second-row
 * growth. The entire rewrite is transactional so an interrupted launch leaves
 * the previous schema and history recoverable.
 *
 * @param {object} database The initialized SQLite database connection.
 * @returns {void}
 */
function migrateDatabaseSchema(database) {
  const metadata = database.prepare(`
    SELECT value FROM metadata WHERE key = 'database_schema_version'
  `).get();
  const parsedVersion = Number.parseInt(metadata?.value || "0", 10);
  const schemaVersion = Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0;
  if (schemaVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Database schema ${schemaVersion} is newer than this FiberX release supports.`);
  }

  const usageColumns = new Set(database.prepare("PRAGMA table_info(usage_samples)").all().map((column) => column.name));
  const deviceColumns = new Set(database.prepare("PRAGMA table_info(device_usage_samples)").all().map((column) => column.name));
  const usageIndexes = new Set(database.prepare("PRAGMA index_list(usage_samples)").all().map((index) => index.name));
  const deviceIndexes = new Set(database.prepare("PRAGMA index_list(device_usage_samples)").all().map((index) => index.name));
  const requiresUpgrade = schemaVersion < DATABASE_SCHEMA_VERSION
    || !usageColumns.has("poll_count")
    || !deviceColumns.has("poll_count")
    || !usageIndexes.has("usage_samples_day_unique_idx")
    || !deviceIndexes.has("device_usage_samples_month_device_unique_idx");
  if (!requiresUpgrade) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (!usageColumns.has("poll_count")) {
      database.exec("ALTER TABLE usage_samples ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 1;");
    }
    if (!deviceColumns.has("poll_count")) {
      database.exec("ALTER TABLE device_usage_samples ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 1;");
    }

    const compactedStore = readStoreFromDatabase(database);
    database.exec("DELETE FROM usage_samples; DELETE FROM device_usage_samples;");
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS usage_samples_day_unique_idx
        ON usage_samples (day);
      CREATE UNIQUE INDEX IF NOT EXISTS device_usage_samples_month_device_unique_idx
        ON device_usage_samples (month, device_id);
    `);
    insertUsageSampleRows(database, compactedStore.samples);
    insertDeviceUsageSampleRows(database, compactedStore.deviceUsageSamples);
    database.prepare(`
      UPDATE state SET version = ?, updated_at = ? WHERE id = 1
    `).run(STORE_VERSION, new Date().toISOString());
    database.prepare(`
      INSERT INTO metadata (key, value) VALUES ('database_schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(DATABASE_SCHEMA_VERSION));
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the original migration error for the caller.
    }
    throw error;
  }
}

/**
 * Parses one nullable JSON column from SQLite without allowing malformed
 * optional state to prevent the rest of the usage history from loading.
 *
 * @param {string|null|undefined} value A JSON column value.
 * @returns {object|Array|null} The parsed value or null when absent/invalid.
 */
function parseJsonColumn(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

/**
 * Serializes optional state for a nullable SQLite JSON column.
 *
 * @param {object|Array|null|undefined} value A value to serialize.
 * @returns {string|null} JSON text or null when the value is absent.
 */
function serializeJsonColumn(value) {
  return value === null || typeof value === "undefined" ? null : JSON.stringify(value);
}

/**
 * Reads all normalized application state from the SQLite tables used by the
 * dashboard and reconstructs the store shape consumed by existing functions.
 *
 * @param {object} database The initialized SQLite database connection.
 * @returns {object} A normalized usage store.
 */
function readStoreFromDatabase(database) {
  const settings = database.prepare(`
    SELECT plan_mode, cap_gb, billing_start_day
    FROM settings
    WHERE id = 1
  `).get();
  const state = database.prepare(`
    SELECT version, baseline_json, last_counters_json, last_router_json,
      last_devices_json, last_offline_gap_json
    FROM state
    WHERE id = 1
  `).get();
  const samples = database.prepare(`
    SELECT captured_at, day, month, rx_bytes, tx_bytes, rx_delta_bytes,
      tx_delta_bytes, usage_bytes, counter_reset, offline_gap_json, sample_count,
      poll_count
    FROM usage_samples
    ORDER BY captured_at ASC
  `).all().map((sample) => ({
    capturedAt: sample.captured_at,
    day: sample.day,
    month: sample.month,
    rxBytes: sample.rx_bytes,
    txBytes: sample.tx_bytes,
    rxDeltaBytes: sample.rx_delta_bytes,
    txDeltaBytes: sample.tx_delta_bytes,
    usageBytes: sample.usage_bytes,
    counterReset: Boolean(sample.counter_reset),
    offlineGap: parseJsonColumn(sample.offline_gap_json),
    sampleCount: sample.sample_count,
    pollCount: sample.poll_count,
  }));
  const deviceUsageSamples = database.prepare(`
    SELECT captured_at, day, month, device_id, name, mac, ip,
      rx_delta_bytes, tx_delta_bytes, usage_bytes, counter_reset, baseline,
      poll_count
    FROM device_usage_samples
    ORDER BY captured_at ASC, device_id ASC
  `).all().map((sample) => ({
    capturedAt: sample.captured_at,
    day: sample.day,
    month: sample.month,
    deviceId: sample.device_id,
    name: sample.name,
    mac: sample.mac,
    ip: sample.ip,
    rxDeltaBytes: sample.rx_delta_bytes,
    txDeltaBytes: sample.tx_delta_bytes,
    usageBytes: sample.usage_bytes,
    counterReset: Boolean(sample.counter_reset),
    baseline: Boolean(sample.baseline),
    pollCount: sample.poll_count,
  }));

  return normalizeStore({
    version: state?.version || STORE_VERSION,
    settings: settings ? {
      planMode: settings.plan_mode,
      capGb: settings.cap_gb,
      billingStartDay: settings.billing_start_day,
    } : null,
    baseline: parseJsonColumn(state?.baseline_json),
    lastCounters: parseJsonColumn(state?.last_counters_json),
    lastRouter: parseJsonColumn(state?.last_router_json),
    lastDevices: parseJsonColumn(state?.last_devices_json),
    lastOfflineGap: parseJsonColumn(state?.last_offline_gap_json),
    deviceUsageSamples,
    samples,
  });
}

/**
 * Imports the existing JSON store exactly once into SQLite and leaves the JSON
 * file untouched as a recoverable backup. A metadata marker prevents duplicate
 * rows when the server is restarted after migration.
 *
 * @param {object} database The initialized SQLite database connection.
 * @returns {void}
 */
function migrateLegacyJson(database) {
  const marker = database.prepare(`
    SELECT value FROM metadata WHERE key = 'legacy_json_migration'
  `).get();
  if (marker) {
    return;
  }

  let legacyStore = null;
  if (fs.existsSync(JSON_DATA_FILE)) {
    const contents = fs.readFileSync(JSON_DATA_FILE, "utf8");
    legacyStore = normalizeStore(JSON.parse(contents));
  }

  if (legacyStore) {
    writeStoreToDatabase(database, legacyStore, { replaceHistory: true });
  }
  database.prepare(`
    INSERT INTO metadata (key, value) VALUES ('legacy_json_migration', ?)
  `).run(legacyStore ? "imported" : "no-legacy-file");
}

/**
 * Upserts normalized WAN aggregates by calendar day. Updating the existing row
 * keeps its identity stable while replacing its exact counters and accumulated
 * poll count with the latest in-memory aggregate.
 *
 * @param {object} database The initialized SQLite database connection.
 * @param {object[]} rows Normalized daily WAN aggregates to persist.
 * @returns {void}
 */
function insertUsageSampleRows(database, rows) {
  const insertSample = database.prepare(`
    INSERT INTO usage_samples (
      captured_at, day, month, rx_bytes, tx_bytes, rx_delta_bytes,
      tx_delta_bytes, usage_bytes, counter_reset, offline_gap_json,
      sample_count, poll_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      captured_at = excluded.captured_at,
      month = excluded.month,
      rx_bytes = excluded.rx_bytes,
      tx_bytes = excluded.tx_bytes,
      rx_delta_bytes = excluded.rx_delta_bytes,
      tx_delta_bytes = excluded.tx_delta_bytes,
      usage_bytes = excluded.usage_bytes,
      counter_reset = excluded.counter_reset,
      offline_gap_json = excluded.offline_gap_json,
      sample_count = excluded.sample_count,
      poll_count = excluded.poll_count
  `);
  rows.forEach((usageSample) => {
    insertSample.run(
      usageSample.capturedAt,
      usageSample.day,
      usageSample.month,
      normalizeCounter(usageSample.rxBytes),
      normalizeCounter(usageSample.txBytes),
      normalizeCounter(usageSample.rxDeltaBytes),
      normalizeCounter(usageSample.txDeltaBytes),
      normalizeCounter(usageSample.usageBytes),
      usageSample.counterReset ? 1 : 0,
      serializeJsonColumn(usageSample.offlineGap),
      normalizePersistedCount(usageSample.sampleCount, 0),
      Math.max(1, normalizePersistedCount(usageSample.pollCount, 1)),
    );
  });
}

/**
 * Upserts normalized device aggregates by calendar month and stable identity.
 * This key bounds long-running persistence while retaining exact per-device
 * deltas for every identity admitted by the monthly safety ceiling.
 *
 * @param {object} database The initialized SQLite database connection.
 * @param {object[]} rows Normalized monthly device aggregates to persist.
 * @returns {void}
 */
function insertDeviceUsageSampleRows(database, rows) {
  const insertDeviceSample = database.prepare(`
    INSERT INTO device_usage_samples (
      captured_at, day, month, device_id, name, mac, ip, rx_delta_bytes,
      tx_delta_bytes, usage_bytes, counter_reset, baseline, poll_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month, device_id) DO UPDATE SET
      captured_at = excluded.captured_at,
      day = excluded.day,
      name = excluded.name,
      mac = excluded.mac,
      ip = excluded.ip,
      rx_delta_bytes = excluded.rx_delta_bytes,
      tx_delta_bytes = excluded.tx_delta_bytes,
      usage_bytes = excluded.usage_bytes,
      counter_reset = excluded.counter_reset,
      baseline = excluded.baseline,
      poll_count = excluded.poll_count
  `);
  rows.forEach((deviceSample) => {
    insertDeviceSample.run(
      deviceSample.capturedAt,
      deviceSample.day,
      deviceSample.month,
      String(deviceSample.deviceId).slice(0, MAX_DEVICE_FIELD_LENGTH),
      deviceSample.name ? String(deviceSample.name).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
      deviceSample.mac ? String(deviceSample.mac).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
      deviceSample.ip ? String(deviceSample.ip).slice(0, MAX_DEVICE_FIELD_LENGTH) : null,
      normalizeCounter(deviceSample.rxDeltaBytes),
      normalizeCounter(deviceSample.txDeltaBytes),
      normalizeCounter(deviceSample.usageBytes),
      deviceSample.counterReset ? 1 : 0,
      deviceSample.baseline ? 1 : 0,
      Math.max(1, normalizePersistedCount(deviceSample.pollCount, 1)),
    );
  });
}

/**
 * Writes singleton state and optional new history rows inside one SQLite
 * transaction. Incremental writes replace only the touched daily WAN and
 * monthly device keys with their latest exact aggregates.
 *
 * @param {object} database The initialized SQLite database connection.
 * @param {object} store The normalized store to persist.
 * @param {{sample?:object|null,deviceUsageSamples?:object[],deletedDeviceUsageSamples?:object[],replaceHistory?:boolean}} options Write mode options.
 * @returns {void}
 */
function writeStoreToDatabase(database, store, options = {}) {
  const sample = options.sample || null;
  const deviceUsageSamples = Array.isArray(options.deviceUsageSamples) ? options.deviceUsageSamples : [];
  const deletedDeviceUsageSamples = Array.isArray(options.deletedDeviceUsageSamples)
    ? options.deletedDeviceUsageSamples
    : [];
  const replaceHistory = Boolean(options.replaceHistory);

  database.exec("BEGIN IMMEDIATE");
  try {
    if (replaceHistory) {
      database.exec("DELETE FROM usage_samples; DELETE FROM device_usage_samples;");
    }

    database.prepare(`
      INSERT OR REPLACE INTO settings (id, plan_mode, cap_gb, billing_start_day)
      VALUES (1, ?, ?, ?)
    `).run(store.settings.planMode, store.settings.capGb, store.settings.billingStartDay);
    database.prepare(`
      INSERT OR REPLACE INTO state (
        id, version, baseline_json, last_counters_json, last_router_json,
        last_devices_json, last_offline_gap_json, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      STORE_VERSION,
      serializeJsonColumn(store.baseline),
      serializeJsonColumn(store.lastCounters),
      serializeJsonColumn(store.lastRouter),
      serializeJsonColumn(store.lastDevices),
      serializeJsonColumn(store.lastOfflineGap),
      new Date().toISOString(),
    );

    const sampleRows = replaceHistory ? store.samples : sample ? [sample] : [];
    insertUsageSampleRows(database, sampleRows);
    const deleteDeviceSample = database.prepare(`
      DELETE FROM device_usage_samples WHERE month = ? AND device_id = ?
    `);
    deletedDeviceUsageSamples.forEach((deviceSample) => {
      deleteDeviceSample.run(
        String(deviceSample.month),
        String(deviceSample.deviceId).slice(0, MAX_DEVICE_FIELD_LENGTH),
      );
    });
    const deviceRows = replaceHistory ? store.deviceUsageSamples : deviceUsageSamples;
    insertDeviceUsageSampleRows(database, deviceRows);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the original transaction error for the caller.
    }
    throw error;
  }
}

/**
 * Adds two non-negative decimal counter strings using BigInt so long-running
 * router counters remain exact even after they exceed Number's safe range.
 *
 * @param {string|number|null|undefined} first The first counter.
 * @param {string|number|null|undefined} second The second counter.
 * @returns {string} The exact decimal sum.
 */
function addCounterStrings(first, second) {
  return (BigInt(normalizeCounter(first)) + BigInt(normalizeCounter(second))).toString();
}

/**
 * Normalizes a router-provided counter field to digits only, treating empty or
 * malformed values as zero instead of allowing them into persisted arithmetic.
 *
 * @param {string|number|null|undefined} value A raw counter value.
 * @returns {string} A non-negative decimal string.
 */
function normalizeCounter(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length >= 1 && normalized.length <= MAX_COUNTER_DIGITS && /^\d+$/.test(normalized)
    ? normalized
    : "0";
}

/**
 * Calculates the delta between two cumulative counters and detects a router
 * reboot or interface reset. On reset, the current counter is treated as the
 * new interval's usage so the tracker does not produce a negative delta.
 *
 * @param {string|number} current The latest cumulative value.
 * @param {string|number|null|undefined} previous The previous cumulative value.
 * @returns {{delta:string,reset:boolean}} Exact delta and reset flag.
 */
function calculateCounterDelta(current, previous) {
  const currentValue = BigInt(normalizeCounter(current));
  const previousValue = BigInt(normalizeCounter(previous));
  if (currentValue < previousValue) {
    return { delta: currentValue.toString(), reset: true };
  }

  return { delta: (currentValue - previousValue).toString(), reset: false };
}

/**
 * Detects a collection gap long enough to represent a stopped or sleeping
 * laptop. Normal polling jitter stays below the threshold; a later sample can
 * then be labeled as the usage accumulated while the collector was away.
 *
 * @param {object|null|undefined} previousCounters The last persisted counters.
 * @param {Date} capturedAt Timestamp of the current router sample.
 * @returns {{startedAt:string,endedAt:string,durationSeconds:number}|null} Gap metadata or null.
 */
function detectOfflineGap(previousCounters, capturedAt) {
  if (!previousCounters?.capturedAt) {
    return null;
  }

  const previousTimestamp = Date.parse(previousCounters.capturedAt);
  const currentTimestamp = capturedAt.getTime();
  const elapsedMilliseconds = currentTimestamp - previousTimestamp;
  const minimumGapMilliseconds = getConfig().collectionIntervalMs * 1.5;
  if (!Number.isFinite(previousTimestamp) || elapsedMilliseconds <= minimumGapMilliseconds) {
    return null;
  }

  return {
    startedAt: new Date(previousTimestamp).toISOString(),
    endedAt: capturedAt.toISOString(),
    durationSeconds: Math.round(elapsedMilliseconds / 1_000),
  };
}

/**
 * Converts a Date into a calendar key in the configured usage timezone so a
 * midnight in Lagos does not get split by the machine's UTC offset.
 *
 * @param {Date} date The timestamp to convert.
 * @param {"day"|"month"} granularity The desired key granularity.
 * @returns {string} A YYYY-MM-DD or YYYY-MM key.
 */
function getCalendarKey(date, granularity) {
  const config = getConfig();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.usageTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = {};
  parts.forEach((part) => {
    values[part.type] = part.value;
  });

  const monthKey = `${values.year}-${values.month}`;
  return granularity === "month" ? monthKey : `${monthKey}-${values.day}`;
}

/**
 * Extracts quoted arguments from Huawei's JavaScript response format and
 * decodes the hexadecimal escapes used by the embedded web UI.
 *
 * @param {string} argumentText The contents inside a constructor call.
 * @returns {string[]} Decoded quoted arguments.
 */
function parseQuotedArguments(argumentText) {
  const matches = argumentText.match(/"((?:\\.|[^"\\])*)"/g) || [];
  return matches.map((quoted) => decodeRouterValue(quoted.slice(1, -1)));
}

/**
 * Decodes the hexadecimal and escaped characters used in Huawei's generated
 * JavaScript responses.
 *
 * @param {string} value An encoded router string without surrounding quotes.
 * @returns {string} A readable string value.
 */
function decodeRouterValue(value) {
  return String(value)
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(["'\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .trim();
}

/**
 * Splits a JavaScript constructor argument list without breaking commas inside
 * quoted strings or nested arrays.
 *
 * @param {string} argumentText Text inside a constructor's parentheses.
 * @returns {string[]} Raw JavaScript argument values.
 */
function splitJavaScriptArguments(argumentText) {
  const values = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let nesting = 0;

  for (const character of argumentText) {
    if (quote) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      nesting += 1;
    } else if (character === "]" || character === "}" || character === ")") {
      nesting = Math.max(0, nesting - 1);
    }
    if (character === "," && nesting === 0) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim() || argumentText.trim().endsWith(",")) {
    values.push(current.trim());
  }
  return values;
}

/**
 * Converts a JavaScript literal emitted by the router into a string value for
 * the dashboard's normalization layer.
 *
 * @param {string|undefined} literal A raw constructor argument.
 * @returns {string} A decoded string, or an empty string for null-like values.
 */
function decodeJavaScriptLiteral(literal) {
  const value = String(literal || "").trim();
  if (!value || value === "null" || value === "undefined" || value === "NaN") {
    return "";
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return decodeRouterValue(value.slice(1, -1));
  }
  return decodeRouterValue(value);
}

/**
 * Normalizes field names from the router's mixed JavaScript and HTML naming
 * conventions so aliases such as ReceivingRate and rx_rate can be matched.
 *
 * @param {string} fieldName A raw field or column name.
 * @returns {string} Lowercase alphanumeric field name.
 */
function normalizeDeviceFieldName(fieldName) {
  return String(fieldName || "").slice(0, MAX_DEVICE_FIELD_LENGTH).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Reads the first non-empty value matching a list of normalized field aliases.
 * Exact aliases win over contains matches to avoid confusing TX and RX fields.
 *
 * @param {object} fields Raw field/value pairs.
 * @param {string[]} aliases Normalized field aliases.
 * @returns {string} The matched value, or an empty string.
 */
function readDeviceField(fields, aliases) {
  const entries = Object.entries(fields).map(([key, value]) => ({
    key: normalizeDeviceFieldName(key),
    value: String(value || "").trim().slice(0, MAX_DEVICE_FIELD_LENGTH),
  }));

  for (const alias of aliases) {
    const exact = entries.find((entry) => entry.key === alias && entry.value !== "");
    if (exact) {
      return exact.value;
    }
  }
  for (const alias of aliases) {
    const partial = entries.find((entry) => entry.key.includes(alias) && entry.value !== "");
    if (partial) {
      return partial.value;
    }
  }
  return "";
}

/**
 * Parses an optional numeric field while preserving null for unavailable data.
 *
 * @param {string} value A raw numeric field.
 * @returns {number|null} Parsed number or null when unavailable.
 */
function parseOptionalNumber(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * Parses a device link rate into megabits per second while honoring explicit
 * units and the kilobit-per-second convention used by stAssociatedDevice.
 *
 * @param {string} value A raw router rate field.
 * @param {"Kbps"|"Mbps"} defaultUnit Unit to use when the router omits one.
 * @returns {number|null} Rate in megabits per second, or null when unavailable.
 */
function parseOptionalRateMbps(value, defaultUnit = "Mbps") {
  const rawValue = String(value || "").replace(/,/g, "").trim();
  const parsed = parseOptionalNumber(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (/k(?:bps|bit|b\/s)/i.test(rawValue)) {
    return parsed / 1_000;
  }
  if (/m(?:bps|bit|b\/s)/i.test(rawValue)) {
    return parsed;
  }
  return defaultUnit === "Kbps" ? parsed / 1_000 : parsed;
}

/**
 * Parses an optional cumulative byte field without turning an unavailable
 * marker such as -- into a misleading zero.
 *
 * @param {string} value A raw byte field.
 * @returns {string|null} Exact decimal byte string or null.
 */
function parseOptionalCounter(value) {
  return /^\d+$/.test(String(value || "").trim()) ? normalizeCounter(value) : null;
}

/**
 * Converts a field map into one safe connected-device record. The record keeps
 * both negotiated link rates and optional byte counters; many Huawei GPON
 * firmwares expose the former but not the latter per station.
 *
 * @param {object} fields Raw device fields.
 * @param {string} source Router endpoint that produced the fields.
 * @param {string} constructorName Optional source constructor name.
 * @returns {object|null} Normalized device record, or null for non-device rows.
 */
function normalizeDeviceRecord(fields, source, constructorName = "") {
  const mac = readDeviceField(fields, ["macaddress", "hardwareaddress", "mac"]);
  const ip = readDeviceField(fields, ["ipaddress", "ipv4address", "ip"]);
  const hostName = readDeviceField(fields, [
    "hostname",
    "devicename",
    "clientname",
    "friendlyname",
    "description",
    "associateddevicedescription",
  ]);
  const genericName = readDeviceField(fields, ["name"]);
  const name = hostName || genericName || "Unknown device";
  if (!mac && !ip && name === "Unknown device") {
    return null;
  }

  const txRate = readDeviceField(fields, ["sendingrate", "transmitrate", "txrate", "sendrate", "uplinkrate"]);
  const rxRate = readDeviceField(fields, ["receivingrate", "receiverrate", "rxrate", "receiverate", "downlinkrate"]);
  const rxBytes = parseOptionalCounter(readDeviceField(fields, ["bytesreceived", "rxbytes", "receivebytes"]));
  const txBytes = parseOptionalCounter(readDeviceField(fields, ["bytessent", "txbytes", "transmitbytes", "sendbytes"]));
  const defaultRateUnit = constructorName === "stAssociatedDevice" ? "Kbps" : "Mbps";
  const normalizedMac = mac.replace(/-/g, ":").toUpperCase();
  const identity = normalizedMac || ip || `${name}:${readDeviceField(fields, ["ssidname", "ssid"])}`;

  return {
    id: identity,
    name,
    hostName: hostName || null,
    mac: normalizedMac || null,
    ip: ip || null,
    ssid: readDeviceField(fields, ["ssidname", "ssid"]) || null,
    connectionType: readDeviceField(fields, ["connectiontype", "networktype", "interfacetype", "workingmode", "wirelessmode"]) || null,
    durationSeconds: parseOptionalNumber(readDeviceField(fields, ["connectionduration", "duration", "onlineduration", "uptime"])),
    txRateMbps: parseOptionalRateMbps(txRate, defaultRateUnit),
    rxRateMbps: parseOptionalRateMbps(rxRate, defaultRateUnit),
    signalStrengthDbm: parseOptionalNumber(readDeviceField(fields, ["signalstrength", "rssi"])),
    noiseDbm: parseOptionalNumber(readDeviceField(fields, ["noise"])),
    snrDb: parseOptionalNumber(readDeviceField(fields, ["signaltonoiseratio", "snr"])),
    signalQualityDbm: parseOptionalNumber(readDeviceField(fields, ["signalquality", "singalquality", "quality"])),
    rxBytes,
    txBytes,
    source,
    sourceConstructor: constructorName || null,
  };
}

/**
 * Discovers constructor parameter names in a Huawei JavaScript response so the
 * parser remains useful across firmware revisions that rename their classes.
 *
 * @param {string} payload Raw router response text.
 * @returns {Map<string,string[]>} Constructor names mapped to parameter names.
 */
function getRouterConstructorDefinitions(payload) {
  const definitions = new Map();
  for (const match of payload.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    const parameters = splitJavaScriptArguments(match[2]).map((parameter) => parameter.trim()).filter(Boolean);
    definitions.set(match[1], parameters);
  }
  return definitions;
}

/**
 * Parses nested `new SomeHuaweiDevice(...)` calls using the parameter names
 * discovered in the same response. Huawei wraps these records in `new Array`,
 * so the wrapper is skipped to let the station constructor match directly.
 *
 * @param {string} payload Raw router response text.
 * @param {string} source Router endpoint that produced the payload.
 * @returns {object[]} Parsed device records.
 */
function parseRouterConstructorDevices(payload, source) {
  const records = [];
  const definitions = getRouterConstructorDefinitions(payload);
  for (const match of payload.matchAll(/new\s+(?!Array\b)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    if (records.length >= MAX_DEVICE_RECORDS) {
      break;
    }
    const parameters = definitions.get(match[1]) || KNOWN_DEVICE_CONSTRUCTOR_DEFINITIONS[match[1]];
    if (!parameters) {
      continue;
    }

    const values = splitJavaScriptArguments(match[2]).map(decodeJavaScriptLiteral);
    const fields = {};
    parameters.forEach((parameter, index) => {
      fields[parameter] = values[index] || "";
    });
    const record = normalizeDeviceRecord(fields, source, match[1]);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Removes markup and script leftovers from an HTML table cell.
 *
 * @param {string} value Raw HTML cell contents.
 * @returns {string} Normalized cell text.
 */
function stripRouterMarkup(value) {
  return decodeRouterValue(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16))));
}

/**
 * Parses rendered-style HTML tables for firmware variants that return device
 * rows directly instead of JavaScript constructors.
 *
 * @param {string} payload Raw router response text.
 * @param {string} source Router endpoint that produced the payload.
 * @returns {object[]} Parsed device records.
 */
function parseRouterHtmlDevices(payload, source) {
  const records = [];
  let headers = null;
  for (const rowMatch of payload.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (records.length >= MAX_DEVICE_RECORDS) {
      break;
    }
    const cells = Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cell) => stripRouterMarkup(cell[1]));
    if (cells.length < 2) {
      continue;
    }
    if (!headers && cells.some((cell) => /mac|ip address|sending rate|receiving rate/i.test(cell))) {
      headers = cells;
      continue;
    }
    if (!headers) {
      continue;
    }

    const fields = {};
    headers.forEach((header, index) => {
      fields[header] = cells[index] || "";
    });
    const record = normalizeDeviceRecord(fields, source, "html-table");
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Iteratively extracts device-shaped objects from JSON responses used by some
 * Huawei firmware builds. Explicit node and record budgets avoid stack
 * exhaustion and excessive memory use on malformed router responses.
 *
 * @param {unknown} value Parsed JSON value.
 * @param {object[]} records Accumulator for normalized records.
 * @param {string} source Router endpoint that produced the payload.
 * @returns {void}
 */
function collectJsonDeviceObjects(value, records, source) {
  const pending = [value];
  let inspectedNodes = 0;

  while (pending.length > 0 && inspectedNodes < MAX_JSON_NODES && records.length < MAX_DEVICE_RECORDS) {
    const current = pending.pop();
    inspectedNodes += 1;
    const remainingCapacity = Math.max(0, MAX_JSON_NODES - inspectedNodes - pending.length);
    if (Array.isArray(current)) {
      pending.push(...current.slice(0, remainingCapacity));
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }

    const record = normalizeDeviceRecord(current, source, "json");
    if (record) {
      records.push(record);
    }
    pending.push(...Object.values(current).slice(0, remainingCapacity));
  }
}

/**
 * Parses one candidate router response through JSON, constructor, and HTML
 * strategies, then de-duplicates devices by MAC or IP address.
 *
 * @param {string} payload Raw router response text.
 * @param {string} source Router endpoint that produced the payload.
 * @returns {object[]} Normalized connected-device records.
 */
function parseDevicePayload(payload, source) {
  const records = [];
  const trimmed = payload.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      collectJsonDeviceObjects(JSON.parse(trimmed), records, source);
    } catch (error) {
      // Huawei firmware frequently wraps JSON-like data in JavaScript; the
      // constructor and HTML parsers below handle those responses instead.
    }
  }
  records.push(...parseRouterConstructorDevices(payload, source));
  records.push(...parseRouterHtmlDevices(payload, source));
  return mergeDeviceRecords(records).slice(0, MAX_DEVICE_RECORDS);
}

/**
 * Merges identity rows and WLAN rate rows for the same station without
 * replacing useful values with nulls from a less-detailed endpoint.
 *
 * @param {object[]} records Device records from one or more router endpoints.
 * @returns {object[]} De-duplicated device records.
 */
function mergeDeviceRecords(records) {
  const merged = new Map();
  records.forEach((record) => {
    const key = record.mac || record.ip || record.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...record });
      return;
    }

    Object.keys(existing).forEach((field) => {
      const current = existing[field];
      const incoming = record[field];
      const currentMissing = current === null || current === "" || typeof current === "undefined";
      if (currentMissing && incoming !== null && incoming !== "" && typeof incoming !== "undefined") {
        existing[field] = incoming;
      }
    });
  });
  return Array.from(merged.values());
}

/**
 * Determines whether a router field is an exact cumulative byte counter rather
 * than an unavailable marker or a value that was normalized to zero.
 *
 * @param {unknown} value A normalized device counter field.
 * @returns {boolean} Whether the field contains a usable decimal counter.
 */
function isDeviceCounter(value) {
  return value !== null && typeof value !== "undefined" && /^\d+$/.test(String(value));
}

/**
 * Reports which byte directions are available for one connected device.
 * Huawei firmware can expose one direction without exposing the other, so the
 * collector tracks each direction independently instead of discarding partial
 * telemetry.
 *
 * @param {object} device A normalized connected-device record.
 * @returns {{hasRx:boolean,hasTx:boolean}} Available counter directions.
 */
function getDeviceCounterAvailability(device) {
  return {
    hasRx: isDeviceCounter(device?.rxBytes),
    hasTx: isDeviceCounter(device?.txBytes),
  };
}

/**
 * Converts live per-device counters into monthly aggregates. The first counter
 * seen for a device establishes a baseline; later samples use exact RX/TX
 * deltas and handle counter resets without generating negative usage. Only the
 * aggregates touched by this poll are returned for an incremental database
 * upsert.
 *
 * @param {object} store The mutable persisted usage store.
 * @param {object[]} devices The freshly sampled device records.
 * @param {Date} capturedAt Timestamp shared by the router snapshot.
 * @returns {{upserts:object[],deleted:object[]}} Updated aggregates and any
 * rows evicted by the monthly identity ceiling.
 */
function recordDeviceUsageSamples(store, devices, capturedAt) {
  const previousDevices = new Map((store.lastDevices?.devices || []).map((device) => [device.id, device]));
  const previousUsageSamples = store.deviceUsageSamples;
  const day = getCalendarKey(capturedAt, "day");
  const month = getCalendarKey(capturedAt, "month");
  const intervalSamples = [];

  devices.forEach((device) => {
    const availability = getDeviceCounterAvailability(device);
    if (!availability.hasRx && !availability.hasTx) {
      return;
    }

    const previous = previousDevices.get(device.id);
    const previousAvailability = getDeviceCounterAvailability(previous || {});
    const rxDelta = availability.hasRx
      ? (previousAvailability.hasRx ? calculateCounterDelta(device.rxBytes, previous.rxBytes) : { delta: "0", reset: false })
      : { delta: "0", reset: false };
    const txDelta = availability.hasTx
      ? (previousAvailability.hasTx ? calculateCounterDelta(device.txBytes, previous.txBytes) : { delta: "0", reset: false })
      : { delta: "0", reset: false };

    intervalSamples.push({
      capturedAt: capturedAt.toISOString(),
      day,
      month,
      deviceId: device.id,
      name: device.name,
      mac: device.mac,
      ip: device.ip,
      rxDeltaBytes: rxDelta.delta,
      txDeltaBytes: txDelta.delta,
      usageBytes: addCounterStrings(rxDelta.delta, txDelta.delta),
      counterReset: Boolean(rxDelta.reset || txDelta.reset),
      baseline: !(previousAvailability.hasRx && availability.hasRx)
        && !(previousAvailability.hasTx && availability.hasTx),
      pollCount: 1,
    });
  });

  if (intervalSamples.length === 0) {
    return { upserts: [], deleted: [] };
  }

  const touchedKeys = new Set(intervalSamples.map((sample) => `${sample.month}\0${sample.deviceId}`));
  store.deviceUsageSamples = compactDeviceUsageSamples([
    ...store.deviceUsageSamples,
    ...intervalSamples,
  ]);
  const retainedKeys = new Set(store.deviceUsageSamples.map((sample) => `${sample.month}\0${sample.deviceId}`));
  return {
    upserts: store.deviceUsageSamples.filter((sample) => touchedKeys.has(`${sample.month}\0${sample.deviceId}`)),
    deleted: previousUsageSamples.filter((sample) => !retainedKeys.has(`${sample.month}\0${sample.deviceId}`)),
  };
}

/**
 * Aggregates stored per-device rows for the selected calendar month.
 * The result is keyed by the stable device identity so the live device list can
 * display a monthly value without exposing raw router counters to the user.
 *
 * @param {object} store The normalized persisted usage store.
 * @param {string} monthKey A YYYY-MM calendar month key.
 * @returns {Record<string,object>} Monthly usage summaries keyed by device ID.
 */
function buildDeviceUsageSummary(store, monthKey) {
  const usageByDevice = new Map();
  const samples = Array.isArray(store.deviceUsageSamples) ? store.deviceUsageSamples : [];

  samples.filter((sample) => sample.month === monthKey).forEach((sample) => {
    const current = usageByDevice.get(sample.deviceId) || {
      usageBytes: "0",
      rxUsageBytes: "0",
      txUsageBytes: "0",
      sampleCount: 0,
      baselineOnly: true,
      latestCapturedAt: null,
    };
    current.usageBytes = addCounterStrings(current.usageBytes, sample.usageBytes);
    current.rxUsageBytes = addCounterStrings(current.rxUsageBytes, sample.rxDeltaBytes);
    current.txUsageBytes = addCounterStrings(current.txUsageBytes, sample.txDeltaBytes);
    current.sampleCount += Math.max(1, normalizePersistedCount(sample.pollCount, 1));
    current.baselineOnly = current.baselineOnly && Boolean(sample.baseline);
    if (!current.latestCapturedAt || sample.capturedAt > current.latestCapturedAt) {
      current.latestCapturedAt = sample.capturedAt;
    }
    usageByDevice.set(sample.deviceId, current);
  });

  return Object.fromEntries(usageByDevice.entries());
}

/**
 * Queries the firmware's LAN/WLAN device resources, choosing the first working
 * resource in each group so identity and Wi-Fi rate data can be combined.
 *
 * @returns {Promise<{devices:object[],source:string|null,usageAvailable:boolean,error:string|null,sampled:boolean}>} Device snapshot.
 */
async function queryRouterDevices() {
  const records = [];
  const sources = [];

  for (const group of DEVICE_ENDPOINT_GROUPS) {
    for (const endpoint of group.paths) {
      let response;
      try {
        response = await requestRouter(endpoint, { timeoutMs: 5_000 });
      } catch (error) {
        if (String(error.message).includes("reset the connection")) {
          throw error;
        }
        continue;
      }
      if (response.statusCode >= 400 || isRouterLoginPage(response.body)) {
        continue;
      }

      const parsed = parseDevicePayload(response.body, endpoint);
      if (parsed.length > 0) {
        records.push(...parsed);
        sources.push(endpoint);
        break;
      }
    }
  }

  const devices = mergeDeviceRecords(records).slice(0, MAX_DEVICE_RECORDS);
  return {
    devices,
    source: sources.length ? sources.join(" + ") : null,
    usageAvailable: devices.some((device) => {
      const availability = getDeviceCounterAvailability(device);
      return availability.hasRx || availability.hasTx;
    }),
    error: devices.length ? null : "This router returned no compatible connected-device rows.",
    sampled: true,
  };
}

/**
 * Parses the router's WaninfoStats JavaScript response into plain records. The
 * HG8145X7-10 emits bytes in the order TX, RX, packets TX, packets RX, then
 * optional unicast/multicast/broadcast counters.
 *
 * @param {string} payload Raw response text from a WAN statistics endpoint.
 * @returns {Array<object>} Parsed WAN statistics records.
 */
function parseWanStatsPayload(payload) {
  const records = [];
  const matches = payload.matchAll(/new\s+(WaninfoStats|WanEthStats)\s*\(([^)]*)\)/g);

  for (const match of matches) {
    if (records.length >= MAX_WAN_RECORDS) {
      break;
    }
    const values = splitJavaScriptArguments(match[2]).map(decodeJavaScriptLiteral);
    if (values.length < 5) {
      continue;
    }

    const isEthernetStatsShape = match[1] === "WanEthStats";
    const rxBytes = isEthernetStatsShape ? values[1] : values[2];
    const rxPackets = isEthernetStatsShape ? values[2] : values[4];
    const txBytes = isEthernetStatsShape ? values[3] : values[1];
    const txPackets = isEthernetStatsShape ? values[4] : values[3];

    records.push({
      domain: values[0],
      txBytes: normalizeCounter(txBytes),
      rxBytes: normalizeCounter(rxBytes),
      txPackets: normalizeCounter(txPackets),
      rxPackets: normalizeCounter(rxPackets),
    });
  }

  return records;
}

/**
 * Marks a constrained router-client failure as safe for the local dashboard.
 * Callers use this marker to distinguish expected connection/authentication
 * diagnostics from internal storage paths and programming errors.
 *
 * @param {string} message Public router diagnostic.
 * @returns {Error & {code:string,exposeToDashboard:boolean}} Tagged router error.
 */
function createRouterError(message) {
  const error = new Error(message);
  error.code = "ERR_FIBERX_ROUTER_REQUEST";
  error.exposeToDashboard = true;
  return error;
}

/**
 * Merges Set-Cookie response headers into the in-memory router session without
 * writing them to disk or exposing them to the browser.
 *
 * @param {string|string[]|undefined} setCookieHeader Router Set-Cookie values.
 * @returns {void}
 */
function mergeRouterCookies(setCookieHeader) {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  if (values.length > MAX_ROUTER_COOKIES) {
    throw createRouterError("The router returned too many session cookies.");
  }

  values.forEach((value) => {
    const firstPart = value.split(";", 1)[0];
    const separator = firstPart.indexOf("=");
    if (separator < 1) {
      return;
    }

    const name = firstPart.slice(0, separator).trim();
    const cookieValue = firstPart.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || name.length > 128
      || cookieValue.length > 4_096
      || /[\x00-\x20\x7f;,]/.test(cookieValue)) {
      throw createRouterError("The router returned an invalid session cookie.");
    }
    if (cookieValue) {
      routerSession.cookies.set(name, cookieValue);
    } else {
      routerSession.cookies.delete(name);
    }
  });
  if (routerSession.cookies.size > MAX_ROUTER_COOKIES || Buffer.byteLength(getRouterCookieHeader()) > MAX_ROUTER_COOKIE_BYTES) {
    routerSession.cookies.clear();
    throw createRouterError("The router session cookie limit was exceeded.");
  }
}

/**
 * Builds the Cookie header for one router request from the in-memory session.
 *
 * @returns {string} A browser-compatible Cookie header value.
 */
function getRouterCookieHeader() {
  return Array.from(routerSession.cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * Performs one HTTPS/HTTP request against the local router and returns its raw
 * response. TLS verification can be disabled only for the explicitly local
 * router URL because Huawei's embedded UI commonly uses a self-signed cert.
 *
 * @param {string} pathname Router-relative path to request.
 * @param {{method?:string,body?:string,headers?:object,timeoutMs?:number}} options Request options.
 * @returns {Promise<{statusCode:number,headers:object,body:string}>} Raw response.
 */
function requestRouter(pathname, options = {}) {
  const config = getConfig();
  const target = new URL(pathname, config.routerUrl);
  const body = options.body || "";
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000;
  const method = String(options.method || "GET").toUpperCase();
  if (target.origin !== config.routerUrl.origin) {
    throw createRouterError("Router requests must remain on the configured router origin.");
  }
  if (method !== "GET" && method !== "POST") {
    throw createRouterError("Router requests may use only GET or POST.");
  }
  if (Buffer.byteLength(body) > 16_384) {
    throw createRouterError("Router request body is too large.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw createRouterError("Router request timeout is outside the allowed range.");
  }
  const headers = {
    Accept: "*/*",
    Connection: "close",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 FiberXTracker/1.0",
    ...(options.headers || {}),
  };
  const cookieHeader = getRouterCookieHeader();

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  if (method !== "GET" && !headers["Content-Length"]) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  const transport = target.protocol === "https:" ? https : http;
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method,
    path: `${target.pathname}${target.search}`,
    headers,
    agent: false,
    lookup: lookupPrivateRouterAddress,
  };
  if (target.protocol === "https:") {
    requestOptions.rejectUnauthorized = !config.allowInsecureTls && !config.routerTlsFingerprint;
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, (response) => {
      try {
        mergeRouterCookies(response.headers["set-cookie"]);
      } catch (error) {
        response.destroy();
        reject(error);
        return;
      }

      const chunks = [];
      let responseBytes = 0;
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ROUTER_BODY_BYTES) {
        response.destroy(new Error("Router response exceeded the 2 MiB safety limit."));
      }
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_ROUTER_BODY_BYTES) {
          response.destroy(new Error("Router response exceeded the 2 MiB safety limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", (error) => reject(formatRouterRequestError(pathname, error)));
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error("Router request timed out.")));
    request.on("error", (error) => reject(formatRouterRequestError(pathname, error)));
    sendRouterRequest(request, body, config.routerTlsFingerprint);
  });
}

/**
 * Sends a router request immediately for verified/default TLS and plaintext
 * connections, or waits for a self-signed TLS handshake and validates its leaf
 * certificate fingerprint before any headers, token, or password are written.
 *
 * @param {http.ClientRequest} request Prepared router request.
 * @param {string} body Encoded request body.
 * @param {string|null} expectedFingerprint Optional pinned SHA-256 fingerprint.
 * @returns {void}
 */
function sendRouterRequest(request, body, expectedFingerprint) {
  let sent = false;
  const finishRequest = () => {
    if (sent || request.destroyed) {
      return;
    }
    sent = true;
    if (body) {
      request.write(body);
    }
    request.end();
  };

  if (!expectedFingerprint) {
    finishRequest();
    return;
  }

  request.once("socket", (socket) => {
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const actualFingerprint = String(certificate?.fingerprint256 || "").replace(/:/g, "").toUpperCase();
      const actualBuffer = /^[A-F0-9]{64}$/.test(actualFingerprint)
        ? Buffer.from(actualFingerprint, "hex")
        : Buffer.alloc(32);
      const expectedBuffer = Buffer.from(expectedFingerprint, "hex");
      if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
        request.destroy(createRouterError("The router TLS certificate does not match ROUTER_TLS_FINGERPRINT256."));
        return;
      }
      finishRequest();
    });
  });
}

/**
 * Converts low-level socket failures into an actionable message while keeping
 * the original router path visible for diagnosis. Huawei ONT web servers often
 * reset a connection during a login lockout or when a stale keep-alive socket
 * is reused, so the client explicitly closes each request after this change.
 *
 * @param {string} pathname Router-relative path that failed.
 * @param {Error & {code?:string}} error Low-level request error.
 * @returns {Error} A user-facing router request error.
 */
function formatRouterRequestError(pathname, error) {
  const resetCodes = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_WRITE_AFTER_END"]);
  if (resetCodes.has(error.code) || error.message === "socket hang up") {
    return createRouterError(`The router reset the connection while requesting ${pathname}. It may be temporarily locked or the credentials in .env may be invalid.`);
  }

  return createRouterError(`Router request to ${pathname} failed: ${error.message}`);
}

/**
 * Returns true when a Huawei response is the login screen rather than a data
 * payload, allowing the collector to refresh its short-lived session safely.
 *
 * @param {string} body Raw router response body.
 * @returns {boolean} Whether the body looks like the login screen.
 */
function isRouterLoginPage(body) {
  const normalizedBody = body.toLowerCase();

  return normalizedBody.includes('id="txt_username"')
    || normalizedBody.includes("welcome to huawei web page");
}

/**
 * Returns true when Huawei has sent its short intermediate page that redirects
 * the browser back to the root page after login or after an unauthenticated
 * request. This is deliberately separate from the login form because Huawei
 * also uses the same page as the normal successful login response.
 *
 * @param {string} body Raw router response body.
 * @returns {boolean} Whether the body is Huawei's intermediate redirect page.
 */
function isRouterWaitingPage(body) {
  const normalizedBody = body.toLowerCase();

  return normalizedBody.includes("<title>waiting...</title>")
    || normalizedBody.includes("top.location.replace");
}

/**
 * Logs into the Huawei web UI using the same token and base64 password flow as
 * the device's own login page. Credentials are read only from the environment
 * and are never returned in an API response.
 *
 * @returns {Promise<void>} Resolves after the login request is sent.
 */
async function loginToRouter() {
  const config = getConfig();
  if (!config.routerPassword) {
    throw createRouterError("Set ROUTER_PASSWORD before starting the tracker.");
  }

  const waitMilliseconds = routerSession.authBlockedUntil - Date.now();
  if (waitMilliseconds > 0) {
    const waitSeconds = Math.ceil(waitMilliseconds / 1000);
    throw createRouterError(`Router login is paused for ${waitSeconds}s after a failed attempt. Check .env and wait for the router lockout to clear.`);
  }

  routerSession.cookies.clear();
  routerSession.loggedIn = false;

  try {
    await requestRouter("/");
    routerSession.cookies.set("Cookie", "body:Language:english:id=-1");

    const tokenResponse = await requestRouter("/asp/GetRandCount.asp", { method: "POST" });
    const token = tokenResponse.body.trim();
    if (tokenResponse.statusCode >= 400
      || isRouterLoginPage(tokenResponse.body)
      || !/^[A-Za-z0-9._~-]{1,256}$/.test(token)) {
      throw createRouterError("The router did not provide a login token. Wait for the router lockout to clear and try again.");
    }

    const form = new URLSearchParams({
      UserName: config.routerUsername,
      PassWord: Buffer.from(config.routerPassword, "utf8").toString("base64"),
      Language: "english",
      "x.X_HW_Token": token,
    });
    const loginResponse = await requestRouter("/login.cgi", {
      method: "POST",
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (loginResponse.statusCode >= 400 || isRouterLoginPage(loginResponse.body)) {
      throw createRouterError("The router login was rejected. Verify ROUTER_USERNAME and ROUTER_PASSWORD in .env, then wait for any Huawei lockout timer to clear.");
    }

    routerSession.loggedIn = true;
    routerSession.authBlockedUntil = 0;
  } catch (error) {
    routerSession.loggedIn = false;
    routerSession.cookies.clear();
    routerSession.authBlockedUntil = Date.now() + 300_000;
    throw error;
  }
}

/**
 * Queries both Huawei WAN statistics endpoints and combines records from the
 * IP and PPP lists. MTN FiberX on this device reports its active connection in
 * the PPP list; querying both keeps the collector portable across bridge modes.
 *
 * @returns {Promise<object|null>} Aggregated counters or null when unauthenticated.
 */
async function queryRouterStats() {
  const records = [];
  const failures = [];
  let loginRequired = false;

  for (const endpoint of WAN_STATS_ENDPOINTS) {
    let response;
    try {
      response = await requestRouter(endpoint, { timeoutMs: 5_000 });
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`);
      continue;
    }
    if (response.statusCode >= 400 || isRouterLoginPage(response.body) || isRouterWaitingPage(response.body)) {
      if (isRouterLoginPage(response.body) || isRouterWaitingPage(response.body)) {
        loginRequired = true;
        failures.push(`${endpoint}: unauthenticated redirect returned`);
      } else {
        failures.push(`${endpoint}: HTTP ${response.statusCode}`);
      }
      continue;
    }
    const parsed = parseWanStatsPayload(response.body);
    if (parsed.length === 0) {
      failures.push(`${endpoint}: no WaninfoStats payload`);
      continue;
    }
    records.push(...parsed);
  }

  if (records.length === 0) {
    return {
      stats: null,
      loginRequired,
      error: `The router returned no parseable WAN statistics. ${failures.join("; ")}`,
    };
  }

  let txBytes = "0";
  let rxBytes = "0";
  let txPackets = "0";
  let rxPackets = "0";
  records.forEach((record) => {
    txBytes = addCounterStrings(txBytes, record.txBytes);
    rxBytes = addCounterStrings(rxBytes, record.rxBytes);
    txPackets = addCounterStrings(txPackets, record.txPackets);
    rxPackets = addCounterStrings(rxPackets, record.rxPackets);
  });

  return { stats: { records, txBytes, rxBytes, txPackets, rxPackets }, loginRequired: false, error: null };
}

/**
 * Ensures there is an authenticated router session, then retries statistics
 * once after a session expiry or rejected request.
 *
 * @returns {Promise<object>} Aggregated live WAN counters.
 */
async function getRouterStats() {
  if (!routerSession.loggedIn) {
    await loginToRouter();
  }

  let result = await queryRouterStats();
  if (!result.stats && result.loginRequired) {
    routerSession.loggedIn = false;
    await loginToRouter();
    result = await queryRouterStats();
  }
  if (!result.stats) {
    throw createRouterError(result.error || "The router returned no WAN statistics.");
  }

  return result.stats;
}

/**
 * Builds a public router status object while keeping authentication material
 * strictly server-side.
 *
 * @param {object|null} lastRouter The last successful router metadata.
 * @returns {object} Safe status data for the dashboard.
 */
function getPublicRouterStatus(lastRouter) {
  const config = getConfig();
  return {
    connected: Boolean(lastRouter && lastRouter.connected),
    model: (lastRouter && lastRouter.model) || "HG8145X7-10",
    address: config.routerUrl.hostname,
    lastError: lastRouter && lastRouter.connected ? null : lastRouter?.lastError || null,
  };
}

/**
 * Divides an exact byte counter by a small integer for average calculations.
 * The dashboard only needs whole bytes here; it formats the result later.
 *
 * @param {string} counter Exact decimal counter.
 * @param {number} divisor Positive integer divisor.
 * @returns {string} Integer quotient as a decimal string.
 */
function divideCounter(counter, divisor) {
  if (!divisor || divisor < 1) {
    return "0";
  }
  return (BigInt(normalizeCounter(counter)) / BigInt(divisor)).toString();
}

/**
 * Returns the number of days in a YYYY-MM calendar month for projection math.
 *
 * @param {string} monthKey A YYYY-MM month key.
 * @returns {number} The month's day count.
 */
function getDaysInMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

/**
 * Converts stored samples into daily totals and the card values used by the
 * screenshot-inspired dashboard.
 *
 * @param {object} store The persisted history store.
 * @param {string} monthKey The selected YYYY-MM month.
 * @returns {object} A normalized dashboard summary.
 */
function buildSummary(store, monthKey) {
  const filteredSamples = store.samples.filter((sample) => sample.month === monthKey);
  const deviceUsageSummary = buildDeviceUsageSummary(store, monthKey);
  const dailyMap = new Map();

  filteredSamples.forEach((sample) => {
    const current = dailyMap.get(sample.day) || { day: sample.day, usageBytes: "0", sampleCount: 0 };
    current.usageBytes = addCounterStrings(current.usageBytes, sample.usageBytes);
    current.sampleCount += Math.max(1, normalizePersistedCount(sample.pollCount, 1));
    dailyMap.set(sample.day, current);
  });

  const daily = Array.from(dailyMap.values()).sort((first, second) => first.day.localeCompare(second.day));
  const totalUsageBytes = daily.reduce((total, row) => addCounterStrings(total, row.usageBytes), "0");
  const daysRecorded = daily.length;
  const latest = daily[daysRecorded - 1] || null;
  const dailyAverageBytes = divideCounter(totalUsageBytes, daysRecorded);
  const projectedMonthEndBytes = daysRecorded ? (BigInt(dailyAverageBytes) * BigInt(getDaysInMonth(monthKey))).toString() : "0";

  return {
    month: monthKey,
    totalUsageBytes,
    latestDayUsageBytes: latest ? latest.usageBytes : "0",
    latestDay: latest ? latest.day : null,
    dailyAverageBytes,
    projectedMonthEndBytes,
    daysRecorded,
    daily,
    sampleCount: filteredSamples.reduce((total, sample) => (
      Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(1, normalizePersistedCount(sample.pollCount, 1)))
    ), 0),
    rxBytes: store.lastCounters?.rxBytes || "0",
    txBytes: store.lastCounters?.txBytes || "0",
    lastSyncAt: store.lastRouter?.capturedAt || null,
    baselineAt: store.baseline?.capturedAt || null,
    lastOfflineGap: store.lastOfflineGap || null,
    settings: store.settings,
    devices: (store.lastDevices?.devices || []).map((device) => ({
      ...device,
      deviceUsage: deviceUsageSummary[device.id] || null,
    })),
    deviceSource: store.lastDevices?.source || null,
    deviceUsageAvailable: Boolean(store.lastDevices?.usageAvailable),
    deviceLastSyncAt: store.lastDevices?.capturedAt || null,
    deviceError: store.lastDevices?.error || null,
    pollIntervalSeconds: Math.round(getConfig().collectionIntervalMs / 1_000),
    router: getPublicRouterStatus(store.lastRouter),
  };
}

/**
 * Validates a calendar month accepted by history and export routes. Restricting
 * the numeric month prevents ambiguous Date normalization and keeps generated
 * download filenames inside a fixed, header-safe character set.
 *
 * @param {string|null} value Candidate YYYY-MM value.
 * @returns {string|null} The validated key, or null when invalid.
 */
function parseMonthKey(value) {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value || "") ? value : null;
}

/**
 * Samples the live router, calculates exact counter deltas, and persists one
 * history row. A process-wide promise lock prevents concurrent UI requests
 * from double-counting the same interval.
 *
 * @returns {Promise<object>} The refreshed normalized dashboard summary.
 */
async function collectSnapshot() {
  if (collectionPromise) {
    return collectionPromise;
  }

  collectionPromise = queueStoreMutation(collectSnapshotInternal).finally(() => {
    collectionPromise = null;
  });
  return collectionPromise;
}

/**
 * Performs the single snapshot operation used by the collection lock.
 *
 * @returns {Promise<object>} The refreshed current-month summary.
 */
async function collectSnapshotInternal() {
  const store = await readUsageStore();
  const stats = await getRouterStats();
  let deviceSnapshot;
  try {
    deviceSnapshot = await queryRouterDevices();
  } catch (error) {
    const publicMessage = getPublicRouterErrorMessage(error);
    if (!error?.exposeToDashboard) {
      console.error("Connected-device collection failed:", error);
    }
    deviceSnapshot = {
      devices: store.lastDevices?.devices || [],
      source: store.lastDevices?.source || null,
      usageAvailable: Boolean(store.lastDevices?.usageAvailable),
      error: publicMessage,
      sampled: false,
    };
  }
  const capturedAt = new Date();
  const day = getCalendarKey(capturedAt, "day");
  const month = getCalendarKey(capturedAt, "month");
  const previous = store.lastCounters;
  const rxDelta = calculateCounterDelta(stats.rxBytes, previous?.rxBytes || "0");
  const txDelta = calculateCounterDelta(stats.txBytes, previous?.txBytes || "0");
  const usageBytes = previous ? addCounterStrings(rxDelta.delta, txDelta.delta) : "0";
  const counterReset = Boolean(previous && (rxDelta.reset || txDelta.reset));
  const detectedGap = detectOfflineGap(previous, capturedAt);
  const offlineGap = detectedGap
    ? {
      ...detectedGap,
      usageBytes: previous && !counterReset ? usageBytes : null,
      counterReset,
    }
    : null;
  const sample = {
    capturedAt: capturedAt.toISOString(),
    day,
    month,
    rxBytes: stats.rxBytes,
    txBytes: stats.txBytes,
    rxDeltaBytes: previous ? rxDelta.delta : "0",
    txDeltaBytes: previous ? txDelta.delta : "0",
    usageBytes,
    counterReset,
    offlineGap,
    sampleCount: stats.records.length,
    pollCount: 1,
  };

  let deviceUsageSamples = [];
  let deletedDeviceUsageSamples = [];
  if (deviceSnapshot.sampled) {
    const devicePersistenceChanges = recordDeviceUsageSamples(store, deviceSnapshot.devices, capturedAt);
    deviceUsageSamples = devicePersistenceChanges.upserts;
    deletedDeviceUsageSamples = devicePersistenceChanges.deleted;
  }

  if (!store.baseline) {
    store.baseline = {
      capturedAt: capturedAt.toISOString(),
      rxBytes: stats.rxBytes,
      txBytes: stats.txBytes,
    };
  }
  store.lastCounters = { capturedAt: capturedAt.toISOString(), rxBytes: stats.rxBytes, txBytes: stats.txBytes };
  store.lastOfflineGap = offlineGap || store.lastOfflineGap;
  store.lastRouter = {
    connected: true,
    capturedAt: capturedAt.toISOString(),
    model: "HG8145X7-10",
  };
  store.lastDevices = {
    capturedAt: capturedAt.toISOString(),
    devices: deviceSnapshot.devices,
    source: deviceSnapshot.source,
    usageAvailable: deviceSnapshot.usageAvailable,
    error: deviceSnapshot.error || null,
  };
  store.samples = compactUsageSamples([...store.samples, sample]);
  const dailySample = store.samples.find((storedSample) => storedSample.day === day);
  if (!dailySample) {
    throw new Error("The current usage sample could not be normalized for persistence.");
  }
  await persistUsageStore(store, {
    sample: dailySample,
    deviceUsageSamples,
    deletedDeviceUsageSamples,
  });

  return buildSummary(store, month);
}

/**
 * Reads a bounded request body so local API endpoints cannot consume an
 * unbounded amount of memory if a malformed client sends oversized input.
 *
 * @param {http.IncomingMessage} request The incoming HTTP request.
 * @returns {Promise<string>} The UTF-8 request body.
 */
function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      reject(createHttpError(413, "Request body is too large."));
      return;
    }

    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(createHttpError(413, "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("aborted", () => reject(createHttpError(400, "Request body was interrupted.")));
    request.on("error", reject);
  });
}

/**
 * Creates an HTTP error whose status and public message are safe to return to a
 * client. Unexpected exceptions omit these fields and are converted to a
 * generic 500 response by the request handler.
 *
 * @param {number} statusCode HTTP status code to expose.
 * @param {string} message Public error message.
 * @param {Record<string,string>} headers Safe response headers such as an authentication challenge.
 * @returns {Error & {statusCode:number,expose:boolean,headers:Record<string,string>}} A controlled HTTP error.
 */
function createHttpError(statusCode, message, headers = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  error.headers = headers;
  return error;
}

/**
 * Writes a response status and headers with the security policy shared by HTML,
 * JavaScript, JSON, and CSV responses. Route-specific headers may override only
 * representation details such as content type, length, and cache policy.
 *
 * @param {http.ServerResponse} response The outgoing response.
 * @param {number} statusCode HTTP status code.
 * @param {Record<string,string|number>} headers Route-specific headers.
 * @returns {void}
 */
function writeSecureHead(response, statusCode, headers = {}) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...headers,
  });
}

/**
 * Converts a router-collection failure into a message safe for the dashboard.
 * Network errors created by the constrained router client are actionable;
 * storage, programming, and OS details remain in the private server log.
 *
 * @param {unknown} error Router collection failure.
 * @returns {string} A public diagnostic without local filesystem internals.
 */
function getPublicRouterErrorMessage(error) {
  return error?.exposeToDashboard && error instanceof Error
    ? error.message
    : "Router sync failed. Check the private server log for details.";
}

/**
 * Sends a JSON response with a same-origin policy suitable for the localhost
 * dashboard and a cache directive that keeps telemetry fresh.
 *
 * @param {http.ServerResponse} response The outgoing response.
 * @param {number} statusCode HTTP status code.
 * @param {object} payload JSON-serializable payload.
 * @param {Record<string,string>} headers Additional safe response headers.
 * @returns {void}
 */
function sendJson(response, statusCode, payload, headers = {}) {
  const serialized = JSON.stringify(payload);
  writeSecureHead(response, statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
    ...headers,
  });
  response.end(serialized);
}

/**
 * Validates the loopback request authority before any route or file is served.
 * Exact Host and local-peer checks stop DNS rebinding from turning an attacker
 * controlled origin into a same-origin caller of this localhost service.
 *
 * @param {http.IncomingMessage} request The incoming request.
 * @returns {string} The normalized expected browser origin.
 */
function validateLoopbackAuthority(request) {
  const remoteAddress = request.socket.remoteAddress || "";
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
    throw createHttpError(403, "Loopback access only.");
  }

  const hostHeaderCount = request.rawHeaders.reduce((count, value, index) => (
    index % 2 === 0 && value.toLowerCase() === "host" ? count + 1 : count
  ), 0);
  const hostHeader = request.headers.host;
  if (hostHeaderCount !== 1 || typeof hostHeader !== "string") {
    throw createHttpError(400, "A single valid Host header is required.");
  }

  let authority;
  try {
    authority = new URL(`http://${hostHeader}`);
  } catch (error) {
    throw createHttpError(400, "The Host header is invalid.");
  }
  const hostname = authority.hostname.toLowerCase();
  const expectedPort = String(getConfig().port);
  const authorityPort = authority.port || (authority.protocol === "http:" ? "80" : "443");
  if ((hostname !== "127.0.0.1" && hostname !== "localhost")
    || authorityPort !== expectedPort
    || authority.username
    || authority.password
    || authority.pathname !== "/"
    || authority.search
    || authority.hash) {
    throw createHttpError(421, "The requested host is not served here.");
  }

  return authority.origin;
}

/**
 * Requires the dashboard's HTTP Basic credential using a constant-time digest
 * comparison. Duplicate, oversized, malformed, and non-Basic Authorization
 * headers all receive the same challenge without logging credential material.
 *
 * @param {http.IncomingMessage} request The incoming protected request.
 * @returns {void}
 */
function requireDashboardAuthentication(request) {
  const authorizationHeaderCount = request.rawHeaders.reduce((count, value, index) => (
    index % 2 === 0 && value.toLowerCase() === "authorization" ? count + 1 : count
  ), 0);
  const authorization = request.headers.authorization;
  const challenge = { "WWW-Authenticate": 'Basic realm="FiberX", charset="UTF-8"' };
  if (authorizationHeaderCount !== 1
    || typeof authorization !== "string"
    || authorization.length > 1_024
    || !authorization.startsWith("Basic ")) {
    throw createHttpError(401, "Dashboard authentication is required.", challenge);
  }

  const encodedCredential = authorization.slice(6).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCredential)) {
    throw createHttpError(401, "Dashboard authentication is required.", challenge);
  }
  const decodedBuffer = Buffer.from(encodedCredential, "base64");
  const canonicalBase64 = decodedBuffer.toString("base64").replace(/=+$/, "");
  if (canonicalBase64 !== encodedCredential.replace(/=+$/, "")) {
    throw createHttpError(401, "Dashboard authentication is required.", challenge);
  }

  const separator = decodedBuffer.indexOf(0x3a);
  if (separator < 1) {
    throw createHttpError(401, "Dashboard authentication is required.", challenge);
  }
  const suppliedUsername = decodedBuffer.subarray(0, separator).toString("utf8");
  const suppliedPassword = decodedBuffer.subarray(separator + 1).toString("utf8");
  const config = getConfig();
  const suppliedDigest = crypto.createHash("sha256").update(`${suppliedUsername}\0${suppliedPassword}`).digest();
  const expectedDigest = crypto.createHash("sha256").update(`${config.dashboardUsername}\0${config.dashboardPassword}`).digest();
  if (!crypto.timingSafeEqual(suppliedDigest, expectedDigest)) {
    throw createHttpError(401, "Dashboard authentication is required.", challenge);
  }
}

/**
 * Applies browser-origin and Fetch Metadata checks to local API calls. Command
 * line clients without browser headers remain usable, while cross-site pages,
 * sandboxed documents, and browser extensions cannot invoke the router API.
 *
 * @param {http.IncomingMessage} request The incoming API request.
 * @param {string} expectedOrigin Origin derived from the validated Host header.
 * @returns {void}
 */
function validateApiBrowserBoundary(request, expectedOrigin) {
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw createHttpError(403, "Cross-site API requests are not allowed.");
  }

  const originHeader = request.headers.origin;
  if (typeof originHeader === "undefined") {
    return;
  }
  if (typeof originHeader !== "string" || originHeader === "null") {
    throw createHttpError(403, "The request origin is not allowed.");
  }

  let origin;
  try {
    origin = new URL(originHeader);
  } catch (error) {
    throw createHttpError(403, "The request origin is not allowed.");
  }
  if (origin.origin !== expectedOrigin
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash) {
    throw createHttpError(403, "The request origin is not allowed.");
  }
}

/**
 * Enforces JSON on state-changing routes. Requiring a non-simple content type
 * provides an additional CSRF barrier and gives malformed clients a clear 415
 * response before any request body is parsed.
 *
 * @param {http.IncomingMessage} request The incoming request.
 * @returns {void}
 */
function requireJsonRequest(request) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  const contentEncoding = String(request.headers["content-encoding"] || "identity").trim().toLowerCase();
  if (contentType !== "application/json") {
    throw createHttpError(415, "Content-Type must be application/json.");
  }
  if (contentEncoding !== "identity") {
    throw createHttpError(415, "Compressed request bodies are not supported.");
  }
}

/**
 * Reads and parses a bounded JSON request body without reflecting JavaScript
 * parser diagnostics to the client.
 *
 * @param {http.IncomingMessage} request The incoming request.
 * @returns {Promise<object>} A plain JSON object supplied by the client.
 */
async function readJsonRequest(request) {
  requireJsonRequest(request);
  const body = await readRequestBody(request);
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch (error) {
    throw createHttpError(400, "Request body must contain valid JSON.");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw createHttpError(400, "Request body must contain a JSON object.");
  }

  return input;
}

/**
 * Builds a CSV document from daily usage rows for the selected month.
 *
 * @param {object} summary A dashboard summary.
 * @returns {string} CSV content with a header row.
 */
function buildCsv(summary) {
  const lines = ["date,usage_gb,samples"];
  summary.daily.forEach((row) => {
    const usageGb = (Number(row.usageBytes) / 1_000_000_000).toFixed(6);
    lines.push(`${row.day},${usageGb},${row.sampleCount}`);
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Serves one allow-listed static asset and rejects path traversal attempts.
 *
 * @param {http.ServerResponse} response The outgoing response.
 * @param {string} requestPath The URL pathname.
 * @returns {Promise<boolean>} Whether an asset response was sent.
 */
async function serveStaticAsset(response, requestPath) {
  const assetName = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const allowedAssets = new Set(["index.html", "styles.css", "app.js"]);
  if (!allowedAssets.has(assetName)) {
    return false;
  }

  const filePath = path.join(ROOT_DIRECTORY, assetName);
  const contents = await fsPromises.readFile(filePath);
  const contentTypes = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
  };
  writeSecureHead(response, 200, {
    "Content-Type": contentTypes[assetName],
    "Cache-Control": "no-cache",
    "Content-Length": contents.length,
  });
  response.end(contents);
  return true;
}

/**
 * Handles the localhost API and static files for the dashboard.
 *
 * @param {http.IncomingMessage} request The incoming request.
 * @param {http.ServerResponse} response The outgoing response.
 * @returns {Promise<void>} Resolves after the response has completed.
 */
async function handleRequest(request, response) {
  try {
    const expectedOrigin = validateLoopbackAuthority(request);
    const rawUrl = request.url || "/";
    if (Buffer.byteLength(rawUrl) > MAX_REQUEST_URL_BYTES
      || !rawUrl.startsWith("/")
      || rawUrl.startsWith("//")
      || rawUrl.includes("\\")) {
      throw createHttpError(400, "The request target is invalid.");
    }
    const requestUrl = new URL(rawUrl, "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      writeSecureHead(response, 204, {
        "Cache-Control": "no-store",
        "Content-Length": 0,
      });
      response.end();
      return;
    }

    requireDashboardAuthentication(request);
    const isApiRequest = requestUrl.pathname.startsWith("/api/");
    if (isApiRequest) {
      validateApiBrowserBoundary(request, expectedOrigin);
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/usage") {
      const month = parseMonthKey(requestUrl.searchParams.get("month")) || getCalendarKey(new Date(), "month");
      sendJson(response, 200, buildSummary(await readUsageStore(), month));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
      const input = await readJsonRequest(request);
      if (Object.keys(input).length !== 0) {
        throw createHttpError(400, "Router sync does not accept request fields.");
      }
      const month = parseMonthKey(requestUrl.searchParams.get("month")) || getCalendarKey(new Date(), "month");
      let store = await readUsageStore();
      try {
        const collectedSummary = await collectSnapshot();
        store = await readUsageStore();
        const summary = collectedSummary.month === month ? collectedSummary : buildSummary(store, month);
        sendJson(response, 200, summary);
      } catch (error) {
        const publicMessage = getPublicRouterErrorMessage(error);
        if (!error?.exposeToDashboard) {
          console.error("Manual router sync failed:", error);
        }
        store.lastRouter = {
          ...(store.lastRouter || {}),
          connected: false,
          lastError: publicMessage,
        };
        const summary = buildSummary(store, month);
        sendJson(response, 503, { ...summary, error: store.lastRouter.lastError, summary });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/settings") {
      const input = await readJsonRequest(request);
      const planMode = input.planMode === "capped" ? "capped" : "unlimited";
      const capGb = Number(input.capGb);
      const billingStartDay = Number(input.billingStartDay);

      if (input.planMode !== "unlimited" && input.planMode !== "capped") {
        sendJson(response, 400, { error: "Plan mode must be unlimited or capped." });
        return;
      }
      if (!Number.isFinite(capGb) || capGb <= 0 || capGb > 100_000) {
        sendJson(response, 400, { error: "Monthly cap must be between 1 and 100000 GB." });
        return;
      }
      if (!Number.isInteger(billingStartDay) || billingStartDay < 1 || billingStartDay > 28) {
        sendJson(response, 400, { error: "Billing cycle start day must be between 1 and 28." });
        return;
      }

      const settings = { planMode, capGb, billingStartDay };
      await queueStoreMutation(async () => {
        const store = await readUsageStore();
        store.settings = settings;
        await persistUsageStore(store);
      });
      sendJson(response, 200, { settings });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/export.csv") {
      const month = parseMonthKey(requestUrl.searchParams.get("month")) || getCalendarKey(new Date(), "month");
      const summary = buildSummary(await readUsageStore(), month);
      const csv = buildCsv(summary);
      writeSecureHead(response, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fiberx-${month}.csv"`,
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(csv),
      });
      response.end(csv);
      return;
    }

    if (request.method === "GET" && (await serveStaticAsset(response, requestUrl.pathname))) {
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const message = error?.expose ? error.message : "Unexpected server error.";
    if (statusCode >= 500) {
      console.error("Request failed:", error);
    }
    sendJson(response, statusCode, { error: message }, error?.headers || {});
  }
}

/**
 * Runs one background router collection without allowing a transient router
 * failure to terminate the long-lived local server. Repeated identical errors
 * are logged once until a successful sample clears the condition.
 *
 * @returns {Promise<void>} Resolves after the background attempt is handled.
 */
async function runBackgroundCollection() {
  try {
    await collectSnapshot();
    lastBackgroundCollectionError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Background router sync failed.";
    if (message !== lastBackgroundCollectionError) {
      console.error(`Background router sync failed: ${message}`);
      lastBackgroundCollectionError = message;
    }
  }
}

/**
 * Starts the server-owned collection timer so usage history continues to build
 * when no dashboard tab is open. The timer is intentionally kept on the server
 * rather than the browser because a closed tab cannot reliably poll the router.
 *
 * @returns {void}
 */
function startBackgroundCollection() {
  if (backgroundCollectionTimer) {
    return;
  }

  const config = getConfig();
  void runBackgroundCollection();
  backgroundCollectionTimer = setInterval(() => {
    void runBackgroundCollection();
  }, config.collectionIntervalMs);
}

/**
 * Starts the local-only HTTP server and prints only non-sensitive connection
 * information for the operator.
 *
 * @returns {http.Server} The running dashboard server.
 */
function startServer() {
  const config = getConfig();
  getStorageBackend();
  const server = http.createServer({
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 16_384,
    requestTimeout: 15_000,
    requireHostHeader: true,
  }, (request, response) => {
    void handleRequest(request, response);
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`FiberX tracker: http://${config.host}:${config.port}`);
    console.log(`Router source: ${config.routerUrl.origin}`);
    console.log(`Background collection interval: ${config.collectionIntervalMs / 1_000}s`);
    startBackgroundCollection();
  });
  return server;
}

assertSupportedNodeRuntime();
startServer();
