#!/usr/bin/env bash

# Removes only the optional FiberX menu-bar companion. The FiberX collector,
# local history, credentials, and server LaunchAgent are intentionally kept.
set -euo pipefail
umask 077

APP_NAME="FiberX.app"
INSTALLED_APP="${HOME}/Applications/${APP_NAME}"
MENUBAR_LABEL="com.mtn.fiberx.menubar"
USER_DOMAIN="gui/$(id -u)"
MENUBAR_TARGET="${USER_DOMAIN}/${MENUBAR_LABEL}"
LAUNCH_AGENT_FILE="${HOME}/Library/LaunchAgents/${MENUBAR_LABEL}.plist"

##
# Stops and removes the menu-bar LaunchAgent when it is installed.
#
# @returns Nothing.
##
remove_launch_agent() {
  if launchctl print "${MENUBAR_TARGET}" >/dev/null 2>&1; then
    launchctl bootout "${MENUBAR_TARGET}" >/dev/null 2>&1 || true
  fi
  rm -f -- "${LAUNCH_AGENT_FILE}"
}

##
# Removes the installed menu-bar application bundle without touching FiberX
# data, configuration, logs, or the separate background collector service.
#
# @returns Nothing.
##
remove_app_bundle() {
  if [[ -d "${INSTALLED_APP}" ]]; then
    rm -rf -- "${INSTALLED_APP}"
  fi
}

##
# Runs the scoped uninstallation and reports what remains available.
#
# @returns Nothing after the companion has been removed.
##
main() {
  [[ "$(uname -s)" == "Darwin" ]] || {
    printf 'FiberX menu-bar uninstallation failed: this script only runs on macOS.\n' >&2
    exit 1
  }
  remove_launch_agent
  remove_app_bundle
  printf 'FiberX menu-bar app removed. The background collector and local data were kept.\n'
}

main "$@"
