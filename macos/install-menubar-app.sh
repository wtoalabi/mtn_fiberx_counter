#!/usr/bin/env bash

# Builds and installs the optional FiberX menu-bar companion using only the
# Swift compiler and AppKit framework already available on macOS. The output
# is ad-hoc signed, which is suitable for the current Mac but not for App Store
# distribution or trusted downloads to other people's Macs.
set -euo pipefail
umask 077

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
SOURCE_FILE="${SCRIPT_DIRECTORY}/FiberXMenuBar.swift"
APP_NAME="FiberX.app"
APP_INSTALL_DIRECTORY="${HOME}/Applications"
INSTALLED_APP="${APP_INSTALL_DIRECTORY}/${APP_NAME}"
MENUBAR_LABEL="com.mtn.fiberx.menubar"
USER_DOMAIN="gui/$(id -u)"
MENUBAR_TARGET="${USER_DOMAIN}/${MENUBAR_LABEL}"
LAUNCH_AGENT_DIRECTORY="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT_FILE="${LAUNCH_AGENT_DIRECTORY}/${MENUBAR_LABEL}.plist"
FIBERX_TEMP_ROOT="${TMPDIR:-/tmp}"
BUILD_DIRECTORY=""
FIBERX_PORT="3000"

##
# Prints an actionable error and stops installation.
#
# @param message The user-facing failure message.
##
die() {
  printf 'FiberX menu-bar installation failed: %s\n' "$1" >&2
  exit 1
}

##
# Removes the temporary app bundle after a successful or failed build.
#
# @returns Nothing.
##
cleanup() {
  if [[ -n "${BUILD_DIRECTORY}" && -d "${BUILD_DIRECTORY}" ]]; then
    rm -rf -- "${BUILD_DIRECTORY}"
  fi
}

##
# Ensures the local macOS command-line tools needed by this installer exist.
#
# @returns Nothing; exits when a required tool is unavailable.
##
validate_runtime() {
  [[ "$(uname -s)" == "Darwin" ]] || die "this installer only runs on macOS."
  command -v swiftc >/dev/null 2>&1 || die "swiftc was not found. Install Apple's Command Line Tools, then run this script again."
  command -v codesign >/dev/null 2>&1 || die "codesign was not found. Install Apple's Command Line Tools, then run this script again."
  command -v launchctl >/dev/null 2>&1 || die "launchctl was not found."
  command -v plutil >/dev/null 2>&1 || die "plutil was not found."
  [[ -f "${SOURCE_FILE}" ]] || die "FiberXMenuBar.swift was not found beside this installer."
}

##
# Reads the optional PORT setting so the status item opens the same local port
# as the Node server. Invalid values are rejected rather than silently pointing
# the menu item at a different service.
#
# @returns The validated port through the global variable.
##
read_dashboard_port() {
  if [[ ! -f "${PROJECT_DIRECTORY}/.env" ]]; then
    return
  fi

  local configured_port=""
  configured_port="$(sed -n 's/^PORT=//p' "${PROJECT_DIRECTORY}/.env" | head -n 1)"
  configured_port="${configured_port%$'\r'}"
  configured_port="${configured_port#\"}"
  configured_port="${configured_port%\"}"
  configured_port="${configured_port#\'}"
  configured_port="${configured_port%\'}"

  if [[ -z "${configured_port}" ]]; then
    return
  fi
  [[ "${configured_port}" =~ ^[0-9]+$ ]] || die "PORT must be a number between 1 and 65535."
  (( configured_port >= 1 && configured_port <= 65535 )) || die "PORT must be a number between 1 and 65535."
  FIBERX_PORT="${configured_port}"
}

##
# Writes the minimal application bundle metadata needed by LaunchServices and
# embeds the configured dashboard port for the Swift helper.
#
# @param app_bundle The temporary .app bundle being assembled.
# @returns Nothing.
##
write_info_plist() {
  local app_bundle="$1"
  cat > "${app_bundle}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>FiberX</string>
  <key>CFBundleExecutable</key>
  <string>FiberXMenuBar</string>
  <key>CFBundleIdentifier</key>
  <string>com.mtn.fiberx.menubar</string>
  <key>CFBundleName</key>
  <string>FiberX</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>FiberXDashboardPort</key>
  <string>${FIBERX_PORT}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF
}

##
# Compiles the Swift source into a temporary menu-bar application bundle and
# applies an ad-hoc signature that does not require a paid Apple account.
#
# @returns The temporary bundle through the global variable.
##
build_app_bundle() {
  BUILD_DIRECTORY="$(mktemp -d "${FIBERX_TEMP_ROOT}/fiberx-menubar.XXXXXX")"
  local app_bundle="${BUILD_DIRECTORY}/${APP_NAME}"
  mkdir -p "${app_bundle}/Contents/MacOS"
  write_info_plist "${app_bundle}"

  swiftc \
    -O \
    -framework AppKit \
    -framework Foundation \
    "${SOURCE_FILE}" \
    -o "${app_bundle}/Contents/MacOS/FiberXMenuBar"
  chmod 755 "${app_bundle}/Contents/MacOS/FiberXMenuBar"
  codesign --force --deep --sign - "${app_bundle}"
  plutil -lint "${app_bundle}/Contents/Info.plist" >/dev/null
}

##
# Stops a previously installed menu-bar LaunchAgent before its bundle and plist
# are replaced. A manually launched copy is not terminated implicitly.
#
# @returns Nothing.
##
unload_existing_agent() {
  if launchctl print "${MENUBAR_TARGET}" >/dev/null 2>&1; then
    launchctl bootout "${MENUBAR_TARGET}" >/dev/null 2>&1 || true
  fi
}

##
# Installs the compiled bundle into the user's Applications directory.
#
# @returns Nothing.
##
install_app_bundle() {
  mkdir -p "${APP_INSTALL_DIRECTORY}"
  if [[ -e "${INSTALLED_APP}" ]]; then
    rm -rf -- "${INSTALLED_APP}"
  fi
  cp -R "${BUILD_DIRECTORY}/${APP_NAME}" "${INSTALLED_APP}"
}

##
# Creates and loads a per-user LaunchAgent so the status item returns at login.
# The collector's separate LaunchAgent remains responsible for the Node server.
#
# @returns Nothing.
##
install_launch_agent() {
  local temporary_file=""
  mkdir -p "${LAUNCH_AGENT_DIRECTORY}"
  temporary_file="$(mktemp "${LAUNCH_AGENT_DIRECTORY}/.${MENUBAR_LABEL}.XXXXXX")"

  cat > "${temporary_file}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALLED_APP}/Contents/MacOS/FiberXMenuBar</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
EOF

  if ! plutil -lint "${temporary_file}" >/dev/null; then
    rm -f -- "${temporary_file}"
    die "the generated menu-bar LaunchAgent plist failed validation."
  fi

  mv -f -- "${temporary_file}" "${LAUNCH_AGENT_FILE}"
  chmod 600 "${LAUNCH_AGENT_FILE}"
  launchctl bootstrap "${USER_DOMAIN}" "${LAUNCH_AGENT_FILE}"
  launchctl kickstart -k "${MENUBAR_TARGET}"
}

##
# Runs the complete local installation workflow and prints the next command
# needed when the FiberX collector has not yet been installed.
#
# @returns Nothing after the menu-bar app is loaded.
##
main() {
  trap cleanup EXIT
  validate_runtime
  read_dashboard_port
  unload_existing_agent
  build_app_bundle
  install_app_bundle
  install_launch_agent

  printf 'FiberX menu-bar app installed at %s.\n' "${INSTALLED_APP}"
  printf 'It will start automatically when you sign in.\n'
  printf 'If the status says Not running, first run: %s/start-fiberx.sh\n' "${PROJECT_DIRECTORY}"
}

main "$@"
