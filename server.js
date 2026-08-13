"use strict";

const fs = require("node:fs");
const fsPromises = fs.promises;
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT_DIRECTORY = __dirname;
const DATA_DIRECTORY = path.join(ROOT_DIRECTORY, "data");
const DATA_FILE = path.join(DATA_DIRECTORY, "usage.json");
const routerSession = {
  cookies: new Map(),
  loggedIn: false,
  authBlockedUntil: 0,
};
let cachedConfig = null;
let collectionPromise = null;
let persistenceQueue = Promise.resolve();

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

  const contents = fs.readFileSync(filePath, "utf8");
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      return;
    }

    const key = trimmed.slice(0, separator).trim();
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
 * Reads and validates runtime configuration while deliberately excluding the
 * router password from any object that is logged or returned to the browser.
 *
 * @returns {{port:number,host:string,routerUrl:URL,routerUsername:string,routerPassword:string,allowInsecureTls:boolean,usageTimezone:string}} Runtime configuration.
 */
function getConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  loadDotEnvFile(path.join(ROOT_DIRECTORY, ".env"));
  const routerUrl = new URL(process.env.ROUTER_URL || "https://192.168.100.1:80");
  const configuredPort = Number.parseInt(process.env.PORT || "3000", 10);

  cachedConfig = {
    port: Number.isFinite(configuredPort) ? configuredPort : 3000,
    host: process.env.HOST || "127.0.0.1",
    routerUrl,
    routerUsername: process.env.ROUTER_USERNAME || "root",
    routerPassword: process.env.ROUTER_PASSWORD || "",
    allowInsecureTls: process.env.ROUTER_INSECURE_TLS !== "false",
    usageTimezone: process.env.USAGE_TIMEZONE || "Africa/Lagos",
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
    version: 1,
    settings: {
      planMode: "unlimited",
      capGb: 500,
      billingStartDay: 1,
    },
    baseline: null,
    lastCounters: null,
    lastRouter: null,
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
    version: 1,
    settings: {
      planMode: settings.planMode === "capped" ? "capped" : empty.settings.planMode,
      capGb: Number.isFinite(Number(settings.capGb)) && Number(settings.capGb) > 0 ? Number(settings.capGb) : empty.settings.capGb,
      billingStartDay: Number.isFinite(Number(settings.billingStartDay)) ? Math.min(28, Math.max(1, Number(settings.billingStartDay))) : empty.settings.billingStartDay,
    },
    baseline: source.baseline && typeof source.baseline === "object" ? source.baseline : null,
    lastCounters: source.lastCounters && typeof source.lastCounters === "object" ? source.lastCounters : null,
    lastRouter: source.lastRouter && typeof source.lastRouter === "object" ? source.lastRouter : null,
    samples: Array.isArray(source.samples) ? source.samples : [],
  };
}

/**
 * Reads the local history file, returning an empty store when no collection has
 * happened yet. The directory is created lazily so a clean checkout stays
 * free of generated files until the app is used.
 *
 * @returns {Promise<object>} The normalized usage store.
 */
async function readUsageStore() {
  try {
    const contents = await fsPromises.readFile(DATA_FILE, "utf8");
    return normalizeStore(JSON.parse(contents));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
    return createEmptyStore();
  }
}

/**
 * Serializes the usage store through a single queue and atomically replaces the
 * local JSON file. This avoids corrupting history when a manual click overlaps
 * the background polling interval.
 *
 * @param {object} store The store to persist.
 * @returns {Promise<void>} Resolves after the queued write completes.
 */
function persistUsageStore(store) {
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  persistenceQueue = persistenceQueue.then(async () => {
    await fsPromises.mkdir(DATA_DIRECTORY, { recursive: true });
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fsPromises.writeFile(temporaryFile, serialized, "utf8");
    await fsPromises.rename(temporaryFile, DATA_FILE);
  });

  return persistenceQueue;
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
  return /^\d+$/.test(normalized) ? normalized : "0";
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
  return matches.map((quoted) => quoted.slice(1, -1).replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
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
  const matches = payload.matchAll(/new\s+WaninfoStats\s*\(([^)]*)\)/g);

  for (const match of matches) {
    const values = parseQuotedArguments(match[1]);
    if (values.length < 5) {
      continue;
    }

    records.push({
      domain: values[0],
      txBytes: normalizeCounter(values[1]),
      rxBytes: normalizeCounter(values[2]),
      txPackets: normalizeCounter(values[3]),
      rxPackets: normalizeCounter(values[4]),
    });
  }

  return records;
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
  values.forEach((value) => {
    const firstPart = value.split(";", 1)[0];
    const separator = firstPart.indexOf("=");
    if (separator < 1) {
      return;
    }

    const name = firstPart.slice(0, separator).trim();
    const cookieValue = firstPart.slice(separator + 1).trim();
    if (cookieValue) {
      routerSession.cookies.set(name, cookieValue);
    } else {
      routerSession.cookies.delete(name);
    }
  });
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
 * @param {{method?:string,body?:string,headers?:object}} options Request options.
 * @returns {Promise<{statusCode:number,headers:object,body:string}>} Raw response.
 */
function requestRouter(pathname, options = {}) {
  const config = getConfig();
  const target = new URL(pathname, config.routerUrl);
  const body = options.body || "";
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
  if (options.method && options.method !== "GET" && !headers["Content-Length"]) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  const transport = target.protocol === "https:" ? https : http;
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: options.method || "GET",
    path: `${target.pathname}${target.search}`,
    headers,
    agent: false,
  };
  if (target.protocol === "https:") {
    requestOptions.rejectUnauthorized = !config.allowInsecureTls;
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, (response) => {
      mergeRouterCookies(response.headers["set-cookie"]);
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });

    request.setTimeout(10_000, () => request.destroy(new Error("Router request timed out.")));
    request.on("error", (error) => reject(formatRouterRequestError(pathname, error)));
    if (body) {
      request.write(body);
    }
    request.end();
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
    return new Error(`The router reset the connection while requesting ${pathname}. It may be temporarily locked or the credentials in .env may be invalid.`);
  }

  return new Error(`Router request to ${pathname} failed: ${error.message}`);
}

/**
 * Returns true when a Huawei response is the login screen rather than a data
 * payload, allowing the collector to refresh its short-lived session safely.
 *
 * @param {string} body Raw router response body.
 * @returns {boolean} Whether the body looks like the login screen.
 */
function isRouterLoginPage(body) {
  return body.includes('id="txt_Username"') || body.includes("Welcome to Huawei web page");
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
    throw new Error("Set ROUTER_PASSWORD before starting the tracker.");
  }

  const waitMilliseconds = routerSession.authBlockedUntil - Date.now();
  if (waitMilliseconds > 0) {
    const waitSeconds = Math.ceil(waitMilliseconds / 1000);
    throw new Error(`Router login is paused for ${waitSeconds}s after a failed attempt. Check .env and wait for the router lockout to clear.`);
  }

  routerSession.cookies.clear();
  routerSession.loggedIn = false;

  try {
    await requestRouter("/");
    routerSession.cookies.set("Cookie", "body:Language:english:id=-1");

    const tokenResponse = await requestRouter("/asp/GetRandCount.asp", { method: "POST" });
    const token = tokenResponse.body.trim();
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
      throw new Error("The router login was rejected. Check the local router settings.");
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
  const endpoints = [
    "/html/bbsp/common/get_wan_list_ipwanstat.asp",
    "/html/bbsp/common/get_wan_list_pppwanstat.asp",
  ];
  const records = [];

  for (const endpoint of endpoints) {
    const response = await requestRouter(endpoint);
    if (response.statusCode >= 400 || isRouterLoginPage(response.body)) {
      return null;
    }
    records.push(...parseWanStatsPayload(response.body));
  }

  if (records.length === 0) {
    return null;
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

  return { records, txBytes, rxBytes, txPackets, rxPackets };
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

  let stats = await queryRouterStats();
  if (!stats) {
    await loginToRouter();
    stats = await queryRouterStats();
  }
  if (!stats) {
    throw new Error("The router returned no WAN statistics.");
  }

  return stats;
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
  const dailyMap = new Map();

  filteredSamples.forEach((sample) => {
    const current = dailyMap.get(sample.day) || { day: sample.day, usageBytes: "0", sampleCount: 0 };
    current.usageBytes = addCounterStrings(current.usageBytes, sample.usageBytes);
    current.sampleCount += 1;
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
    sampleCount: filteredSamples.length,
    rxBytes: store.lastCounters?.rxBytes || "0",
    txBytes: store.lastCounters?.txBytes || "0",
    lastSyncAt: store.lastRouter?.capturedAt || null,
    baselineAt: store.baseline?.capturedAt || null,
    settings: store.settings,
    router: getPublicRouterStatus(store.lastRouter),
  };
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

  collectionPromise = collectSnapshotInternal().finally(() => {
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
  const capturedAt = new Date();
  const day = getCalendarKey(capturedAt, "day");
  const month = getCalendarKey(capturedAt, "month");
  const previous = store.lastCounters;
  const rxDelta = calculateCounterDelta(stats.rxBytes, previous?.rxBytes || "0");
  const txDelta = calculateCounterDelta(stats.txBytes, previous?.txBytes || "0");
  const sample = {
    capturedAt: capturedAt.toISOString(),
    day,
    month,
    rxBytes: stats.rxBytes,
    txBytes: stats.txBytes,
    rxDeltaBytes: previous ? rxDelta.delta : "0",
    txDeltaBytes: previous ? txDelta.delta : "0",
    usageBytes: previous ? addCounterStrings(rxDelta.delta, txDelta.delta) : "0",
    counterReset: Boolean(previous && (rxDelta.reset || txDelta.reset)),
    sampleCount: stats.records.length,
  };

  if (!store.baseline) {
    store.baseline = {
      capturedAt: capturedAt.toISOString(),
      rxBytes: stats.rxBytes,
      txBytes: stats.txBytes,
    };
  }
  store.lastCounters = { capturedAt: capturedAt.toISOString(), rxBytes: stats.rxBytes, txBytes: stats.txBytes };
  store.lastRouter = {
    connected: true,
    capturedAt: capturedAt.toISOString(),
    model: "HG8145X7-10",
  };
  store.samples.push(sample);
  await persistUsageStore(store);

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
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Sends a JSON response with a same-origin policy suitable for the localhost
 * dashboard and a cache directive that keeps telemetry fresh.
 *
 * @param {http.ServerResponse} response The outgoing response.
 * @param {number} statusCode HTTP status code.
 * @param {object} payload JSON-serializable payload.
 * @returns {void}
 */
function sendJson(response, statusCode, payload) {
  const serialized = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
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
  response.writeHead(200, {
    "Content-Type": contentTypes[assetName],
    "Cache-Control": "no-cache",
    "Content-Length": contents.length,
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
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
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/usage") {
      const month = /^\d{4}-\d{2}$/.test(requestUrl.searchParams.get("month") || "") ? requestUrl.searchParams.get("month") : getCalendarKey(new Date(), "month");
      const shouldSync = requestUrl.searchParams.get("sync") !== "0";
      let store = await readUsageStore();
      let summary;

      if (shouldSync) {
        try {
          summary = await collectSnapshot();
          store = await readUsageStore();
        } catch (error) {
          store.lastRouter = {
            ...(store.lastRouter || {}),
            connected: false,
            lastError: error instanceof Error ? error.message : "Router sync failed.",
          };
          summary = buildSummary(store, month);
          sendJson(response, 503, { ...summary, error: store.lastRouter.lastError, summary });
          return;
        }
      }

      summary = summary && summary.month === month ? summary : buildSummary(store, month);
      sendJson(response, 200, summary);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/settings") {
      const body = await readRequestBody(request);
      const input = JSON.parse(body || "{}");
      const store = await readUsageStore();
      const planMode = input.planMode === "capped" ? "capped" : "unlimited";
      const capGb = Number(input.capGb);
      const billingStartDay = Number(input.billingStartDay);

      if (!Number.isFinite(capGb) || capGb <= 0 || capGb > 100_000) {
        sendJson(response, 400, { error: "Monthly cap must be between 1 and 100000 GB." });
        return;
      }
      if (!Number.isInteger(billingStartDay) || billingStartDay < 1 || billingStartDay > 28) {
        sendJson(response, 400, { error: "Billing cycle start day must be between 1 and 28." });
        return;
      }

      store.settings = { planMode, capGb, billingStartDay };
      await persistUsageStore(store);
      sendJson(response, 200, { settings: store.settings });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/export.csv") {
      const month = /^\d{4}-\d{2}$/.test(requestUrl.searchParams.get("month") || "") ? requestUrl.searchParams.get("month") : getCalendarKey(new Date(), "month");
      const summary = buildSummary(await readUsageStore(), month);
      const csv = buildCsv(summary);
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fiberx-${month}.csv"`,
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
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    sendJson(response, 400, { error: message });
  }
}

/**
 * Starts the local-only HTTP server and prints only non-sensitive connection
 * information for the operator.
 *
 * @returns {http.Server} The running dashboard server.
 */
function startServer() {
  const config = getConfig();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  server.listen(config.port, config.host, () => {
    console.log(`FiberX tracker: http://${config.host}:${config.port}`);
    console.log(`Router source: ${config.routerUrl.origin}`);
  });
  return server;
}

startServer();
