"use strict";

/**
 * Holds the browser-side view state for the selected month and the most recent
 * response from the local collector. The router password never enters this
 * state because authentication is handled by the localhost server.
 */
const dashboardState = {
  month: getMonthKey(new Date()),
  summary: null,
  syncTimer: null,
};

/**
 * Provides a stable lookup table for the DOM nodes used by the dashboard.
 * Keeping these references in one place makes the rendering functions easier
 * to audit and prevents accidental selector drift as the UI evolves.
 *
 * @returns {Record<string, HTMLElement>} The dashboard's interactive nodes.
 */
function getDashboardElements() {
  return {
    monthSelector: document.getElementById("month-selector"),
    syncButton: document.getElementById("sync-button"),
    syncLabel: document.getElementById("sync-label"),
    syncDot: document.getElementById("sync-dot"),
    exportButton: document.getElementById("export-button"),
    statusMessage: document.getElementById("status-message"),
    routerCaption: document.getElementById("router-caption"),
    totalUsage: document.getElementById("total-usage"),
    totalDetail: document.getElementById("total-detail"),
    latestUsage: document.getElementById("latest-usage"),
    latestDetail: document.getElementById("latest-detail"),
    dailyAverage: document.getElementById("daily-average"),
    projectionDetail: document.getElementById("projection-detail"),
    planStatus: document.getElementById("plan-status"),
    planDetail: document.getElementById("plan-detail"),
    planBannerTitle: document.getElementById("plan-banner-title"),
    planBannerSubtitle: document.getElementById("plan-banner-subtitle"),
    planChip: document.getElementById("plan-chip"),
    planProgressFill: document.getElementById("plan-progress-fill"),
    chartYAxis: document.getElementById("chart-y-axis"),
    chartBars: document.getElementById("chart-bars"),
    chartEmpty: document.getElementById("chart-empty"),
    planModeInputs: Array.from(document.querySelectorAll('input[name="plan-mode"]')),
    capGb: document.getElementById("cap-gb"),
    billingDay: document.getElementById("billing-day"),
    saveSettings: document.getElementById("save-settings"),
    settingsFeedback: document.getElementById("settings-feedback"),
    burnRate: document.getElementById("burn-rate"),
    projectedEnd: document.getElementById("projected-end"),
    settingsLatestDay: document.getElementById("settings-latest-day"),
    rxCounter: document.getElementById("rx-counter"),
    txCounter: document.getElementById("tx-counter"),
    lastSync: document.getElementById("last-sync"),
    baselineTime: document.getElementById("baseline-time"),
    deviceCount: document.getElementById("device-count"),
    deviceNote: document.getElementById("device-note"),
    deviceRows: document.getElementById("device-rows"),
    devicesEmpty: document.getElementById("devices-empty"),
  };
}

const elements = getDashboardElements();

/**
 * Converts a Date into the YYYY-MM month key used by the collector API.
 *
 * @param {Date} date The date to convert.
 * @returns {string} A zero-padded calendar month key.
 */
function getMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Converts a YYYY-MM key into the label shown in the month selector.
 *
 * @param {string} monthKey The calendar month key.
 * @returns {string} A localized month and year label.
 */
function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(year, month - 1, 1),
  );
}

/**
 * Creates a short month list so the user can inspect locally stored history
 * without introducing a third-party date picker or charting dependency.
 *
 * @returns {void}
 */
function populateMonthSelector() {
  const current = new Date();
  elements.monthSelector.replaceChildren();

  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(current.getFullYear(), current.getMonth() - offset, 1);
    const option = document.createElement("option");
    option.value = getMonthKey(date);
    option.textContent = formatMonthLabel(option.value);
    elements.monthSelector.appendChild(option);
  }

  elements.monthSelector.value = dashboardState.month;
}

/**
 * Converts a decimal byte string from the server into a finite number for
 * display. Carrier usage in this project remains far below JavaScript's unsafe
 * integer threshold when expressed in gigabytes, while the server retains the
 * original counters as decimal strings for exact delta arithmetic.
 *
 * @param {string|number|null|undefined} bytesValue A byte count.
 * @returns {number} A finite byte count suitable for presentation math.
 */
function bytesToNumber(bytesValue) {
  const parsed = Number(bytesValue || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Formats bytes using decimal gigabytes, matching how mobile and fixed-line
 * data plans are normally advertised.
 *
 * @param {string|number|null|undefined} bytesValue A byte count.
 * @param {number} decimals The number of decimal places to show.
 * @returns {string} A human-readable data quantity.
 */
function formatBytes(bytesValue, decimals = 2) {
  const bytes = bytesToNumber(bytesValue);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * Formats a byte count as a compact GB/day rate for the summary cards.
 *
 * @param {string|number|null|undefined} bytesValue A byte count.
 * @returns {string} A compact daily rate label.
 */
function formatDailyRate(bytesValue) {
  return `${(bytesToNumber(bytesValue) / 1_000_000_000).toFixed(2)} GB/d`;
}

/**
 * Formats an ISO timestamp using the browser's local timezone.
 *
 * @param {string|null|undefined} timestamp An ISO timestamp from the server.
 * @returns {string} A concise local date/time label.
 */
function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "--";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Formats an API day key into the short date labels used by the chart and
 * latest-day card.
 *
 * @param {string|null|undefined} dayKey A YYYY-MM-DD date key.
 * @returns {string} A short localized date label.
 */
function formatDayLabel(dayKey) {
  if (!dayKey) {
    return "--";
  }

  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(date);
}

/**
 * Formats a connected-device duration reported by the router in seconds.
 *
 * @param {number|null|undefined} seconds Connection duration in seconds.
 * @returns {string} A compact duration label.
 */
function formatDeviceDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) {
    return "--";
  }

  const totalSeconds = Math.max(0, Math.round(Number(seconds)));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Formats a negotiated station link rate without presenting it as actual
 * internet throughput.
 *
 * @param {number|null|undefined} rateMbps Rate in megabits per second.
 * @returns {string} A link-rate label.
 */
function formatDeviceRate(rateMbps) {
  return Number.isFinite(Number(rateMbps)) ? `${Math.round(Number(rateMbps))} Mbps` : "--";
}

/**
 * Formats the strongest signal field available from the connected-device row.
 *
 * @param {object} device A normalized connected-device record.
 * @returns {string} A signal label.
 */
function formatDeviceSignal(device) {
  if (Number.isFinite(Number(device.signalStrengthDbm))) {
    return `${Math.round(Number(device.signalStrengthDbm))} dBm`;
  }
  if (Number.isFinite(Number(device.signalQualityDbm))) {
    return `${Math.round(Number(device.signalQualityDbm))} dBm`;
  }
  return "--";
}

/**
 * Creates the usage cell for a device. The Huawei station table generally
 * exposes link rates but not per-client byte counters, so the unavailable
 * state is explicit instead of implying that the WAN total belongs to one
 * device.
 *
 * @param {object} device A normalized connected-device record.
 * @returns {HTMLTableCellElement} A populated usage cell.
 */
function createDeviceUsageCell(device) {
  const cell = document.createElement("td");
  const hasRx = device.rxBytes !== null && typeof device.rxBytes !== "undefined";
  const hasTx = device.txBytes !== null && typeof device.txBytes !== "undefined";
  if (hasRx || hasTx) {
    cell.textContent = `RX ${formatBytes(device.rxBytes || 0)} / TX ${formatBytes(device.txBytes || 0)}`;
    return cell;
  }

  cell.className = "device-usage-unavailable";
  cell.textContent = "Not exposed";
  return cell;
}

/**
 * Renders the current connected-device snapshot with identity, association,
 * duration, negotiated rates, signal, and any firmware-provided byte fields.
 *
 * @param {object} summary The normalized collector summary.
 * @returns {void}
 */
function renderDevices(summary) {
  const devices = Array.isArray(summary.devices) ? summary.devices : [];
  elements.deviceRows.replaceChildren();
  elements.deviceCount.textContent = `${devices.length} connected`;
  elements.devicesEmpty.hidden = devices.length > 0;

  if (summary.deviceError && devices.length === 0) {
    elements.deviceNote.textContent = summary.deviceError;
  } else if (summary.deviceUsageAvailable) {
    elements.deviceNote.textContent = "The router returned per-device byte counters as well as negotiated Wi-Fi link rates.";
  } else {
    elements.deviceNote.textContent = "The router reports negotiated Wi-Fi link rates per device. Per-device byte counters are not exposed by this firmware response.";
  }

  devices.forEach((device) => {
    const row = document.createElement("tr");
    const identityCell = document.createElement("td");
    identityCell.className = "device-identity";
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = device.name || "Unknown device";
    const address = document.createElement("span");
    address.className = "device-address";
    address.textContent = device.ip || device.mac || "No address reported";
    identityCell.append(name, address);

    const connectionCell = document.createElement("td");
    connectionCell.textContent = device.ssid || device.connectionType || "Wi-Fi";
    const durationCell = document.createElement("td");
    durationCell.textContent = formatDeviceDuration(device.durationSeconds);
    const rxCell = document.createElement("td");
    rxCell.className = "device-link-rate";
    rxCell.textContent = formatDeviceRate(device.rxRateMbps);
    const txCell = document.createElement("td");
    txCell.className = "device-link-rate";
    txCell.textContent = formatDeviceRate(device.txRateMbps);
    const signalCell = document.createElement("td");
    signalCell.className = "device-signal";
    signalCell.textContent = formatDeviceSignal(device);

    row.append(identityCell, connectionCell, durationCell, rxCell, txCell, signalCell, createDeviceUsageCell(device));
    elements.deviceRows.appendChild(row);
  });
}

/**
 * Updates the one-line status region without exposing server internals or
 * router credentials to the page.
 *
 * @param {string} message The message to show.
 * @param {boolean} isError Whether the message represents an error.
 * @returns {void}
 */
function setStatusMessage(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle("is-error", isError);
}

/**
 * Switches the sync button between idle and active states while a router
 * request is in flight.
 *
 * @param {boolean} isSyncing Whether a sync is currently running.
 * @returns {void}
 */
function setSyncState(isSyncing) {
  elements.syncButton.disabled = isSyncing;
  elements.syncLabel.textContent = isSyncing ? "Syncing…" : "Sync Router";
  elements.syncDot.classList.toggle("is-warning", isSyncing);
}

/**
 * Sets the plan mode controls and keeps the capped-plan input usable only when
 * that mode is selected.
 *
 * @param {string} planMode Either "unlimited" or "capped".
 * @returns {void}
 */
function updatePlanModeState(planMode) {
  elements.planModeInputs.forEach((input) => {
    input.checked = input.value === planMode;
  });
  elements.capGb.disabled = planMode !== "capped";
}

/**
 * Renders the daily bars and matching y-axis labels using native DOM nodes so
 * the dashboard remains dependency-free and works offline after it loads.
 *
 * @param {Array<{day:string,usageBytes:string}>} dailyUsage Daily usage rows.
 * @returns {void}
 */
function renderChart(dailyUsage) {
  elements.chartBars.replaceChildren();
  elements.chartYAxis.replaceChildren();

  const chartRows = dailyUsage.slice(-14);
  const values = chartRows.map((row) => bytesToNumber(row.usageBytes) / 1_000_000_000);
  const maxValue = Math.max(0.01, ...values);
  const axisSteps = [1, 0.75, 0.5, 0.25, 0];
  const axisDecimals = maxValue < 1 ? 2 : 0;

  axisSteps.forEach((step) => {
    const label = document.createElement("span");
    label.textContent = (maxValue * step).toFixed(axisDecimals);
    elements.chartYAxis.appendChild(label);
  });

  chartRows.forEach((row, index) => {
    const value = values[index];
    const column = document.createElement("div");
    column.className = "chart-bar-column";

    const valueLabel = document.createElement("span");
    valueLabel.className = "chart-bar-value";
    valueLabel.textContent = `${value.toFixed(2)} GB`;

    const bar = document.createElement("span");
    bar.className = "chart-bar";
    bar.style.setProperty("--bar-height", `${Math.max(1.5, (value / maxValue) * 100)}%`);
    bar.setAttribute("aria-label", `${formatDayLabel(row.day)}: ${value.toFixed(2)} GB`);

    const label = document.createElement("span");
    label.className = "chart-bar-label";
    label.textContent = formatDayLabel(row.day);

    column.append(valueLabel, bar, label);
    elements.chartBars.appendChild(column);
  });

  elements.chartEmpty.hidden = chartRows.length > 0;
}

/**
 * Renders the summary cards, plan banner, settings panel, and source telemetry
 * from one API response so the UI cannot show mixed-month values.
 *
 * @param {object} summary The normalized summary returned by the collector.
 * @returns {void}
 */
function renderSummary(summary) {
  dashboardState.summary = summary;
  const settings = summary.settings || {};
  const planMode = settings.planMode || "unlimited";
  const totalUsage = bytesToNumber(summary.totalUsageBytes);

  elements.totalUsage.textContent = formatBytes(summary.totalUsageBytes);
  elements.totalDetail.textContent = `${summary.daysRecorded || 0} day${summary.daysRecorded === 1 ? "" : "s"} recorded in month`;
  elements.latestUsage.textContent = formatBytes(summary.latestDayUsageBytes);
  elements.latestDetail.textContent = summary.latestDay ? `Date: ${summary.latestDay}` : "No usage day recorded";
  elements.dailyAverage.textContent = formatDailyRate(summary.dailyAverageBytes);
  elements.projectionDetail.textContent = `Projected: ${formatBytes(summary.projectedMonthEndBytes)}/mo`;
  elements.planStatus.textContent = planMode === "capped" ? "Capped" : "Unlimited";
  elements.planDetail.textContent = planMode === "capped" ? `${settings.capGb || 0} GB cap` : "No cap active";

  elements.planBannerTitle.textContent = planMode === "capped" ? "Capped data plan active" : "Unlimited data plan active";
  elements.planBannerSubtitle.textContent = `${formatBytes(summary.totalUsageBytes)} across ${summary.daysRecorded || 0} day${summary.daysRecorded === 1 ? "" : "s"} recorded`;
  elements.planChip.textContent = planMode === "capped" ? `${settings.capGb || 0} GB CAP` : "UNLIMITED";

  if (planMode === "capped" && Number(settings.capGb) > 0) {
    const capBytes = Number(settings.capGb) * 1_000_000_000;
    const percent = Math.min(100, (totalUsage / capBytes) * 100);
    elements.planProgressFill.style.width = `${Math.max(1, percent)}%`;
  } else {
    elements.planProgressFill.style.width = "100%";
  }

  elements.burnRate.textContent = formatDailyRate(summary.dailyAverageBytes);
  elements.projectedEnd.textContent = formatBytes(summary.projectedMonthEndBytes);
  elements.settingsLatestDay.textContent = summary.latestDay ? formatDayLabel(summary.latestDay) : "--";
  elements.rxCounter.textContent = formatBytes(summary.rxBytes);
  elements.txCounter.textContent = formatBytes(summary.txBytes);
  elements.lastSync.textContent = formatTimestamp(summary.lastSyncAt);
  elements.baselineTime.textContent = formatTimestamp(summary.baselineAt);
  elements.routerCaption.textContent = `${summary.router?.model || "Huawei router"} · ${summary.router?.address || "192.168.100.1"}`;

  updatePlanModeState(planMode);
  elements.capGb.value = settings.capGb || 500;
  elements.billingDay.value = settings.billingStartDay || 1;
  renderChart(summary.daily || []);
  renderDevices(summary);

  if (summary.router && summary.router.connected === false) {
    elements.syncDot.classList.add("is-error");
    elements.syncDot.classList.remove("is-warning");
  } else {
    elements.syncDot.classList.remove("is-error");
  }
}

/**
 * Fetches one normalized summary from the local server and paints it into the
 * dashboard. The sync flag lets month navigation read stored history without
 * creating an unnecessary router sample.
 *
 * @param {boolean} syncRouter Whether the server should sample the router.
 * @returns {Promise<void>} Resolves after the summary has rendered.
 */
async function loadUsage(syncRouter = true) {
  setSyncState(syncRouter);

  try {
    const query = new URLSearchParams({
      month: dashboardState.month,
      sync: syncRouter ? "1" : "0",
    });
    const response = await fetch(`/api/usage?${query.toString()}`, { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok) {
      if (payload.summary) {
        renderSummary(payload.summary);
      }
      throw new Error(payload.error || "The router could not be reached.");
    }

    renderSummary(payload);
    setStatusMessage(payload.router?.connected ? "Router synced locally." : "Showing stored data.");
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : "The router could not be reached.", true);
  } finally {
    setSyncState(false);
  }
}

/**
 * Reads the selected plan mode from the settings radio group.
 *
 * @returns {string} The selected plan mode.
 */
function getSelectedPlanMode() {
  const selected = elements.planModeInputs.find((input) => input.checked);
  return selected ? selected.value : "unlimited";
}

/**
 * Sends the editable plan settings to the local server and refreshes the
 * summary so the cap meter and projected values use the saved configuration.
 *
 * @returns {Promise<void>} Resolves after settings have been saved.
 */
async function savePlanSettings() {
  elements.saveSettings.disabled = true;
  elements.settingsFeedback.textContent = "Saving…";
  elements.settingsFeedback.classList.remove("is-error");

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planMode: getSelectedPlanMode(),
        capGb: Number(elements.capGb.value),
        billingStartDay: Number(elements.billingDay.value),
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Settings could not be saved.");
    }

    elements.settingsFeedback.textContent = "Settings saved.";
    await loadUsage(false);
  } catch (error) {
    elements.settingsFeedback.textContent = error instanceof Error ? error.message : "Settings could not be saved.";
    elements.settingsFeedback.classList.add("is-error");
  } finally {
    elements.saveSettings.disabled = false;
  }
}

/**
 * Downloads the selected month as a CSV file generated from the local history.
 *
 * @returns {void}
 */
function exportSelectedMonth() {
  window.location.href = `/api/export.csv?month=${encodeURIComponent(dashboardState.month)}`;
}

/**
 * Updates the selected month and reads its stored history without sampling a
 * second time just because the user changed the selector.
 *
 * @returns {Promise<void>} Resolves after the selected month has rendered.
 */
async function handleMonthChange() {
  dashboardState.month = elements.monthSelector.value;
  await loadUsage(false);
}

/**
 * Starts a manual router sync from the toolbar.
 *
 * @returns {Promise<void>} Resolves after the sync attempt completes.
 */
async function handleManualSync() {
  await loadUsage(true);
}

/**
 * Keeps the dashboard current while the local server is running. The interval
 * is intentionally conservative so the router's embedded web UI is not polled
 * aggressively on a home connection.
 *
 * @returns {Promise<void>} Resolves after the background sync attempt.
 */
async function handleAutomaticSync() {
  if (!elements.syncButton.disabled) {
    await loadUsage(true);
  }
}

/**
 * Enables the capped-plan input immediately when the user changes the plan
 * selector, before they press Save settings.
 *
 * @returns {void}
 */
function handlePlanModeChange() {
  updatePlanModeState(getSelectedPlanMode());
}

/**
 * Wires the dashboard controls and performs the first stored-history read.
 *
 * @returns {Promise<void>} Resolves after initial rendering is complete.
 */
async function initializeDashboard() {
  populateMonthSelector();
  elements.syncButton.addEventListener("click", handleManualSync);
  elements.exportButton.addEventListener("click", exportSelectedMonth);
  elements.monthSelector.addEventListener("change", handleMonthChange);
  elements.saveSettings.addEventListener("click", savePlanSettings);
  elements.planModeInputs.forEach((input) => input.addEventListener("change", handlePlanModeChange));
  updatePlanModeState("unlimited");
  await loadUsage(true);
  dashboardState.syncTimer = window.setInterval(handleAutomaticSync, 30_000);
}

/**
 * Defers initialization until the document has been parsed while retaining a
 * named handler for straightforward debugging in the browser console.
 *
 * @returns {void}
 */
function handleDomReady() {
  void initializeDashboard();
}

document.addEventListener("DOMContentLoaded", handleDomReady);
