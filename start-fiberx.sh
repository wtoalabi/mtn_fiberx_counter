#!/usr/bin/env bash

# Exit on command errors, unset variables, and failures inside pipelines so a
# partially installed LaunchAgent cannot be mistaken for a successful setup.
set -euo pipefail

APP_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_FILE="${APP_DIRECTORY}/server.js"
SERVICE_LABEL="com.mtn.fiberx.tracker"
USER_DOMAIN="gui/$(id -u)"
SERVICE_TARGET="${USER_DOMAIN}/${SERVICE_LABEL}"
LAUNCH_AGENT_DIRECTORY="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT_FILE="${LAUNCH_AGENT_DIRECTORY}/${SERVICE_LABEL}.plist"
LOG_DIRECTORY="${HOME}/Library/Logs/FiberX"
FIBERX_AGENT_WAS_LOADED=0

##
# Prints an error and stops setup without changing another process that may be
# using the dashboard port.
#
# @param message The user-facing failure message.
##
die() {
  printf 'FiberX setup failed: %s\n' "$1" >&2
  exit 1
}

##
# Finds the absolute Node.js executable used to launch the service. launchd does
# not load interactive shell startup files, so the plist must contain an
# absolute executable path rather than relying on the user's PATH. The server
# selects SQLite or JSON at runtime based on the available Node.js APIs.
#
# @returns The absolute Node.js executable path through the global variable.
##
find_node_binary() {
  local discovered_node=""
  discovered_node="$(command -v node || true)"
  [[ -n "$discovered_node" ]] || die "Node.js was not found. Install Node.js 18+ and run this script again."
  [[ -x "$discovered_node" ]] || die "The Node.js path is not executable: ${discovered_node}"
  FIBERX_NODE_BINARY="$discovered_node"
}

##
# Escapes a filesystem path for safe insertion into an XML plist text node.
#
# @param value A raw filesystem path.
# @returns The XML-escaped path on standard output.
##
xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

##
# Reads the optional PORT value from this checkout's .env file for the status
# message and local health check. The Node server remains the source of truth
# for configuration and still loads the file itself.
#
# @returns The configured port through the global variable.
##
read_dashboard_port() {
  FIBERX_PORT="3000"
  if [[ -f "${APP_DIRECTORY}/.env" ]]; then
    local configured_port=""
    configured_port="$(sed -n 's/^PORT=//p' "${APP_DIRECTORY}/.env" | head -n 1)"
    configured_port="${configured_port%$'\r'}"
    configured_port="${configured_port#\"}"
    configured_port="${configured_port%\"}"
    configured_port="${configured_port#\'}"
    configured_port="${configured_port%\'}"
    if [[ "$configured_port" =~ ^[0-9]+$ ]]; then
      FIBERX_PORT="$configured_port"
    fi
  fi
}

##
# Verifies the local files and macOS tools required to install and start the
# LaunchAgent.
#
# @returns Nothing; exits with an actionable message when a requirement is missing.
##
validate_runtime() {
  [[ -f "$SERVER_FILE" ]] || die "server.js was not found beside this script."
  command -v launchctl >/dev/null 2>&1 || die "launchctl is only available on macOS."
  command -v plutil >/dev/null 2>&1 || die "plutil is required to validate the generated LaunchAgent."
  command -v curl >/dev/null 2>&1 || die "curl is required for the local startup check."
  command -v lsof >/dev/null 2>&1 || die "lsof is required to check whether the dashboard port is already in use."
}

##
# Stops an already-loaded copy of this exact LaunchAgent before replacing its
# generated plist. A foreground server owned by the user is not terminated;
# the port check below reports it so the user can stop it deliberately.
#
# @returns Nothing after the existing service has been unloaded when present.
##
unload_existing_agent() {
  FIBERX_AGENT_WAS_LOADED=0
  if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    FIBERX_AGENT_WAS_LOADED=1
    launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  fi
}

##
# Waits for a Node process owned by the previous LaunchAgent to release the
# dashboard port. launchd stops services asynchronously, so an immediate port
# check could falsely report a duplicate process during a safe reinstall.
#
# @returns Nothing when the port is released or when no prior agent was loaded.
##
wait_for_previous_agent_exit() {
  local attempt=1
  if (( FIBERX_AGENT_WAS_LOADED == 0 )); then
    return
  fi

  while (( attempt <= 10 )); do
    if ! lsof -tiTCP:"${FIBERX_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 1
    ((attempt += 1))
  done
}

##
# Creates the per-user LaunchAgent with the discovered absolute paths. The
# agent starts Node at login, keeps it alive, and writes logs outside the Git
# checkout so generated runtime files do not modify the project.
#
# @returns Nothing after the plist has been validated and installed.
##
install_launch_agent() {
  local escaped_node=""
  local escaped_server=""
  local escaped_app_directory=""
  local escaped_stdout=""
  local escaped_stderr=""
  local temporary_file="${LAUNCH_AGENT_FILE}.tmp.$$"

  mkdir -p "$LAUNCH_AGENT_DIRECTORY" "$LOG_DIRECTORY"
  escaped_node="$(xml_escape "$FIBERX_NODE_BINARY")"
  escaped_server="$(xml_escape "$SERVER_FILE")"
  escaped_app_directory="$(xml_escape "$APP_DIRECTORY")"
  escaped_stdout="$(xml_escape "${LOG_DIRECTORY}/server.log")"
  escaped_stderr="$(xml_escape "${LOG_DIRECTORY}/server-error.log")"

  cat > "$temporary_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escaped_node}</string>
    <string>--no-warnings</string>
    <string>${escaped_server}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escaped_app_directory}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escaped_stdout}</string>
  <key>StandardErrorPath</key>
  <string>${escaped_stderr}</string>
</dict>
</plist>
EOF

  plutil -lint "$temporary_file" >/dev/null || {
    rm -f "$temporary_file"
    die "The generated LaunchAgent plist failed validation."
  }
  mv -f "$temporary_file" "$LAUNCH_AGENT_FILE"
  chmod 644 "$LAUNCH_AGENT_FILE"
}

##
# Refuses to start a second server when another process already owns the
# configured dashboard port. This protects an existing manually started
# process instead of killing it implicitly.
#
# @returns Nothing when the port is available.
##
assert_dashboard_port_available() {
  local existing_pid=""
  local existing_command=""
  existing_pid="$(lsof -tiTCP:"${FIBERX_PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [[ -n "$existing_pid" ]]; then
    existing_command="$(ps -p "$existing_pid" -o command= 2>/dev/null || true)"
    die "port ${FIBERX_PORT} is already in use by PID ${existing_pid} (${existing_command}). Stop that foreground server, then run this script again."
  fi
}

##
# Registers and starts the generated LaunchAgent. The kickstart operation is
# the managed equivalent of running `node server.js`; no duplicate foreground
# Node process is started by this script.
#
# @returns Nothing after launchd has accepted and started the service.
##
start_launch_agent() {
  launchctl bootstrap "$USER_DOMAIN" "$LAUNCH_AGENT_FILE"
  launchctl kickstart -k "$SERVICE_TARGET"
}

##
# Waits briefly for the Node process to bind the configured local port and
# prints the dashboard and log locations. A slow router does not make setup
# fail because the health endpoint is a side-effect-free history read.
#
# @returns Nothing; prints a warning if the service needs more time to start.
##
report_startup() {
  local attempt=1
  while (( attempt <= 10 )); do
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${FIBERX_PORT}/api/usage" >/dev/null 2>&1; then
      printf 'FiberX is running through LaunchAgent %s.\n' "$SERVICE_LABEL"
      printf 'Dashboard: http://127.0.0.1:%s\n' "$FIBERX_PORT"
      printf 'Logs: %s/server.log and %s/server-error.log\n' "$LOG_DIRECTORY" "$LOG_DIRECTORY"
      return
    fi
    sleep 1
    ((attempt += 1))
  done

  printf 'LaunchAgent installed, but the dashboard is not responding yet.\n' >&2
  printf 'Check: launchctl print %s\n' "$SERVICE_TARGET" >&2
  printf 'Logs: %s/server-error.log\n' "$LOG_DIRECTORY" >&2
}

##
# Performs the one-command installation and startup workflow. Re-running the
# script is safe: it refreshes the plist and restarts the same labeled service.
#
# @returns Nothing after setup and startup have completed.
##
main() {
  find_node_binary
  read_dashboard_port
  validate_runtime
  unload_existing_agent
  wait_for_previous_agent_exit
  assert_dashboard_port_available
  install_launch_agent
  start_launch_agent
  report_startup
}

main "$@"
