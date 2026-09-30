#!/usr/bin/env bash
# LaunchDaemon state machine for the backend (ported from local_llm; DEVELOPMENT_PLAN 14.6).
# Called by scripts/backend_service.sh with exactly one mode. Privileged steps use sudo
# locally; the script itself never runs as root.
set -euo pipefail

# Trusted system tools for privileged operations; never a user-supplied launchctl or sudo.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
PROJECT_ROOT="$APORISA_ROOT"
MODE="${1:-help}"

[ "$#" -eq 1 ] || exit 2
case "$MODE" in
  install | start | stop | uninstall | restart | status | doctor | prepare) ;;
  *) exit 2 ;;
esac
fail() { aporisa_error "$*"; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "these service commands are macOS-only"
[ "$(id -u)" -ne 0 ] || fail "do not sudo the whole script; run as the project owner"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"
[ "$(stat -f %u "$PROJECT_ROOT")" = "$(id -u)" ] || fail "run as the project directory owner"
PROJECT_ID="$(printf '%s' "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)"
LABEL="com.aporisa.backend.$RUN_USER.$PROJECT_ID"
TARGET="system/$LABEL"
PLIST_DIR="/Library/LaunchDaemons"
INSTALLED="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$PROJECT_ROOT/deploy/templates/macos/backend.plist"
GENERATED_DIR="$PROJECT_ROOT/deploy/generated/macos/$RUN_USER"
GENERATED="$GENERATED_DIR/$LABEL.plist"
ENTRYPOINT="$PROJECT_ROOT/scripts/service_entrypoint.sh"
STATE_DIR="$PROJECT_ROOT/.runtime/services/backend"
LOCK_DIR="$STATE_DIR/control.lock"
STOP_PENDING="$STATE_DIR/stop.pending"
PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"
TEMP_PLIST=""
LOCK_HELD=0
JOB_INFO=""
JOB_PID=""
SERVICE_STATE=""
AUTOSTART=off
DISABLED=""
SERVICE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
# shellcheck source=../backend/src/aporisa_backend/configs/macos_service.sh
source "$PROJECT_ROOT/backend/src/aporisa_backend/configs/macos_service.sh"
START_SECONDS="$MAC_SERVICE_BACKEND_START_SECONDS"
EXIT_SECONDS="$MAC_SERVICE_BACKEND_EXIT_SECONDS"

cleanup() {
  if [ -n "$TEMP_PLIST" ]; then rm -f -- "$TEMP_PLIST"; fi
  if [ "$LOCK_HELD" = 1 ]; then
    rm -f -- "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

lock_control() {
  umask 077
  mkdir -p "$STATE_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null ||
    fail "another management command owns $LOCK_DIR; inspect its pid before removing a stale lock"
  LOCK_HELD=1
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
}

read_job() {
  # Distinguish an inaccessible system domain from an absent job.
  launchctl print system >/dev/null 2>&1 || fail "cannot inspect the launchd system domain"
  JOB_PID=""
  if JOB_INFO="$(launchctl print "$TARGET" 2>/dev/null)"; then
    JOB_PID="$(printf '%s\n' "$JOB_INFO" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
    return 0
  else
    local code=$?
    [ "$code" -eq 113 ] || fail "cannot determine the launchd job state; inspection failed"
  fi
  JOB_INFO=""
  return 1
}

job_has_exited() {
  # "last exit code = (never exited)" appears even for a fresh idle registration; only a
  # numeric exit code or a terminating signal counts.
  printf '%s\n' "$JOB_INFO" | awk '
    $1 == "last" && $2 == "exit" && $3 == "code" && $4 == "=" &&
      $5 ~ /^-?[0-9]+$/ { exited = 1 }
    $1 == "last" && $2 == "terminating" && $3 == "signal" && $4 == "=" &&
      $5 ~ /^[A-Za-z0-9]/ { exited = 1 }
    END { exit !exited }'
}

field() { plutil -extract "$1" raw -o - "$2"; }

# Normalize launchctl's version-dependent output. Unknown or ambiguous values never imply
# enabled startup.
read_autostart() {
  local output raw run_at_load
  if ! output="$(launchctl print-disabled system 2>/dev/null)"; then
    fail "cannot inspect the launchd startup policy; state is unknown"
  fi
  case "$output" in
    *"disabled services = {"*) ;;
    *) fail "unrecognized launchd startup policy output; state is unknown" ;;
  esac
  if ! raw="$(printf '%s\n' "$output" | awk -v label="\"$LABEL\"" '
    $1 == label {
      count++
      if ($2 != "=>" || NF != 3) invalid = 1
      value = $3
    }
    END {
      if (invalid || count > 1) exit 2
      if (count == 0) print "inherit"
      else print value
    }')"; then
    fail "ambiguous launchd startup policy; state is unknown"
  fi
  case "$raw" in
    true | disabled) DISABLED=true ;;
    false | enabled) DISABLED=false ;;
    inherit)
      if ! DISABLED="$(field Disabled "$INSTALLED" 2>/dev/null)"; then DISABLED=false; fi
      case "$DISABLED" in true | false) ;; *) fail "invalid Disabled policy in the installed plist" ;; esac
      ;;
    *) fail "unrecognized launchd startup policy; state is unknown" ;;
  esac
  run_at_load="$(field RunAtLoad "$INSTALLED")" || fail "cannot read the installed startup policy"
  case "$run_at_load" in true | false) ;; *) fail "invalid RunAtLoad policy in the installed plist" ;; esac
  AUTOSTART=off
  if [ "$run_at_load" = true ] && [ "$DISABLED" = false ]; then AUTOSTART=on; fi
}

verify_installation() {
  [ ! -L "$INSTALLED" ] || fail "refusing a symlink at $INSTALLED"
  [ -f "$INSTALLED" ] || fail "the service is not installed; run install first"
  plutil -lint "$INSTALLED" >/dev/null || fail "the installed plist is invalid"
  [ "$(field Label "$INSTALLED")" = "$LABEL" ] &&
    [ "$(field WorkingDirectory "$INSTALLED")" = "$PROJECT_ROOT" ] &&
    [ "$(field UserName "$INSTALLED")" = "$RUN_USER" ] &&
    [ "$(field GroupName "$INSTALLED")" = "$RUN_GROUP" ] &&
    [ "$(field ProgramArguments.0 "$INSTALLED")" = /bin/bash ] &&
    [ "$(field ProgramArguments.1 "$INSTALLED")" = "$ENTRYPOINT" ] &&
    [ "$(field ProgramArguments.2 "$INSTALLED")" = backend ] ||
    fail "the installed service belongs to another checkout or user, or has another entrypoint; refusing to manage it"
  [ "$(stat -f '%u:%g:%Lp' "$INSTALLED")" = "0:0:644" ] || fail "the installed plist must be root:wheel 0644"
}

require_stopped() {
  if [ -e "$INSTALLED" ] || [ -L "$INSTALLED" ]; then verify_installation; fi
  if read_job; then
    [ -f "$INSTALLED" ] || fail "a registered job has no definition; inspect before proceeding"
    if [ -n "$JOB_PID" ] || [ "$(field RunAtLoad "$INSTALLED")" = true ] || job_has_exited; then
      fail "the service is running or failed; run stop first"
    fi
  fi
  [ ! -e "$STOP_PENDING" ] || fail "the previous stop did not finish; run stop again first"
}

load_port() {
  [ -x "$PYTHON" ] || fail "project Python is missing; run prepare"
  PORT="$(cd "$PROJECT_ROOT" && env -u APORISA_API_KEY -u APORISA_BACKEND_PORT "$PYTHON" -B -c \
    'from aporisa_backend.configs.settings import Settings; print(Settings.read(require_key=False).port)')" ||
    fail "cannot read the port from backend/.env; run doctor"
  [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "invalid service port"
  HEALTH_URL="http://127.0.0.1:$PORT/health/ready"
}

service_prerequisites() {
  local failed=0
  if ! plutil -lint "$TEMPLATE" >/dev/null 2>&1; then
    aporisa_log MANUAL "The service template is missing or invalid; restore repository files."
    failed=1
  else
    aporisa_log READY "Service template verified."
  fi
  if [ ! -x "$PROJECT_ROOT/scripts/backend.sh" ] || [ ! -r "$ENTRYPOINT" ]; then
    aporisa_log MANUAL "The service entrypoint is missing; restore repository files."
    failed=1
  fi
  if [ "$(uname -m)" != arm64 ]; then
    aporisa_log SYSTEM "The backend requires Apple silicon."
    failed=1
  fi
  return "$failed"
}

environment_doctor() {
  aporisa_log INFO "Checking the backend environment, model assets and service template..."
  service_prerequisites || return 1
  # Same environment the daemon gets: key and port from backend/.env only.
  env -u APORISA_API_KEY -u APORISA_BACKEND_PORT PATH="$SERVICE_PATH" "$PROJECT_ROOT/scripts/backend.sh" doctor
}

# Always render from the trusted template. Only RunAtLoad changes with lifecycle intent.
render_definition() {
  local autostart="$1" run_home
  [ ! -L "$GENERATED_DIR" ] && [ ! -L "$GENERATED" ] || fail "the generated definition must not be a symlink"
  mkdir -p "$GENERATED_DIR"
  TEMP_PLIST="$(mktemp "$GENERATED_DIR/.render.XXXXXX")"
  cp "$TEMPLATE" "$TEMP_PLIST"
  run_home="$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')"
  [ -d "$run_home" ] || fail "cannot resolve the service user's home directory"
  plutil -replace Label -string "$LABEL" "$TEMP_PLIST"
  plutil -replace RunAtLoad -bool "$autostart" "$TEMP_PLIST"
  plutil -replace UserName -string "$RUN_USER" "$TEMP_PLIST"
  plutil -replace GroupName -string "$RUN_GROUP" "$TEMP_PLIST"
  plutil -replace WorkingDirectory -string "$PROJECT_ROOT" "$TEMP_PLIST"
  plutil -remove ProgramArguments "$TEMP_PLIST"
  plutil -insert ProgramArguments -json '[]' "$TEMP_PLIST"
  plutil -insert ProgramArguments.0 -string /bin/bash "$TEMP_PLIST"
  plutil -insert ProgramArguments.1 -string "$ENTRYPOINT" "$TEMP_PLIST"
  plutil -insert ProgramArguments.2 -string backend "$TEMP_PLIST"
  plutil -replace EnvironmentVariables.PATH -string "$SERVICE_PATH" "$TEMP_PLIST"
  plutil -replace EnvironmentVariables.HOME -string "$run_home" "$TEMP_PLIST"
  plutil -replace ExitTimeOut -integer "$EXIT_SECONDS" "$TEMP_PLIST"
  plutil -lint "$TEMP_PLIST" >/dev/null
}

write_definition() {
  sudo /usr/bin/install -S -o root -g wheel -m 0644 "$TEMP_PLIST" "$INSTALLED"
  mv -f -- "$TEMP_PLIST" "$GENERATED"
  TEMP_PLIST=""
  verify_installation
  aporisa_log READY "Service definition generated and installed: $GENERATED"
}

unload_idle_job() {
  if read_job; then
    [ -z "$JOB_PID" ] || fail "the service acquired a PID; run stop first"
    sudo /bin/launchctl bootout "$TARGET"
  fi
}

register_definition() {
  aporisa_log WAIT "Registering the backend service with launchd..."
  # A disabled label cannot bootstrap. RunAtLoad=false and no other triggers keep install idle.
  sudo /bin/launchctl enable "$TARGET"
  if ! sudo /bin/launchctl bootstrap system "$INSTALLED"; then
    sudo /bin/launchctl disable "$TARGET"
    fail "registration failed; startup disabled. Inspect status and run stop before retrying"
  fi
}

install_service() {
  require_stopped
  environment_doctor
  render_definition false
  sudo /bin/launchctl disable "$TARGET"
  unload_idle_job
  write_definition
  register_definition
  read_job || fail "the registration was not observable"
  [ -z "$JOB_PID" ] || fail "install unexpectedly has a process; run stop and inspect"
  status_service
  [ "$SERVICE_STATE" = REGISTERED_IDLE ] || fail "install did not leave an idle registration"
  aporisa_log READY "Installed and registered without starting. Next: ./backend_service.sh start"
}

healthy() {
  [ -n "$JOB_PID" ] &&
    lsof -nP -a -p "$JOB_PID" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 &&
    curl --noproxy '*' --fail --silent --max-time "$MAC_SERVICE_HEALTH_SECONDS" "$HEALTH_URL" >/dev/null
}

wait_ready() {
  local deadline=$((SECONDS + START_SECONDS))
  aporisa_log WAIT "Waiting for backend readiness (up to ${START_SECONDS}s)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    read_job || fail "the job was unloaded while waiting; inspect status and the console log"
    if healthy; then
      status_service
      [ "$SERVICE_STATE" = READY ] && [ "$AUTOSTART" = on ] || fail "the startup state changed before completion"
      aporisa_log READY "Ready: $TARGET"
      return
    fi
    if [ -z "$JOB_PID" ] && job_has_exited; then
      fail "the service exited before readiness; inspect status and the console log, then stop before retrying"
    fi
    sleep "$MAC_SERVICE_POLL_SECONDS"
  done
  fail "readiness deadline exceeded; the service was NOT stopped implicitly. Inspect status and the console log, or stop it"
}

start_service() {
  verify_installation
  [ ! -e "$STOP_PENDING" ] || fail "the previous stop did not finish; run stop first"
  load_port
  if read_job && [ -n "$JOB_PID" ]; then
    [ "$(field RunAtLoad "$INSTALLED")" = true ] || fail "unexpected running idle registration; run stop first"
    sudo /bin/launchctl enable "$TARGET"
    wait_ready
    return
  fi
  # A crashed active job must pass through stop to finish process cleanup.
  if read_job && { [ "$(field RunAtLoad "$INSTALLED")" = true ] || job_has_exited; }; then
    fail "the service failed; run stop first (or restart)"
  fi
  environment_doctor
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $PORT already has a listener; no process was stopped"
  fi
  if [ -f "$PROJECT_ROOT/.runtime/instance.lock" ] &&
    lsof "$PROJECT_ROOT/.runtime/instance.lock" >/dev/null 2>&1; then
    fail "another backend or prepare holds the instance lock; stop it first"
  fi
  render_definition true
  sudo /bin/launchctl disable "$TARGET"
  unload_idle_job
  write_definition
  register_definition
  wait_ready
}

descendant_pids() {
  # Only PID/PPID are read. Includes the worker, which runs in its own session; never kill
  # by name.
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 1 ] || fail "invalid service PID; refusing to collect a process tree"
  ps -axo pid=,ppid= | awk -v root="$1" '
    NF == 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $1 > 1 {
      parent[$1] = $2
    }
    END {
      found[root] = 1
      for (pass = 0; pass < NR; pass++) {
        changed = 0
        for (pid in parent) if (!(pid in found) && (parent[pid] in found)) {
          found[pid] = 1; changed = 1
        }
        if (!changed) break
      }
      for (pid in found) if (found[pid] == 1 && pid > 1) print pid
    }'
}

stop_service() {
  if [ ! -e "$INSTALLED" ] && [ ! -L "$INSTALLED" ]; then
    [ ! -e "$STOP_PENDING" ] || fail "a stop record remains without an installation; inspect before proceeding"
    if read_job; then fail "a registered job has no definition; inspect before proceeding"; fi
    status_service
    aporisa_log INFO "No installed service to stop."
    return
  fi
  verify_installation
  local tracked="" pid deadline alive remaining job_loaded
  if [ -f "$STOP_PENDING" ]; then tracked="$(cat "$STOP_PENDING")"; fi
  for pid in $tracked; do
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] ||
      fail "invalid PID in stop.pending; inspect it and confirm the shutdown independently"
  done
  # Disable first so a boot or crash cannot race the shutdown with a new launch.
  aporisa_log INFO "Stopping $TARGET: disabling startup and unloading the job..."
  sudo /bin/launchctl disable "$TARGET"
  if read_job; then
    if [ -n "$JOB_PID" ]; then
      local descendants
      descendants="$(descendant_pids "$JOB_PID")" || fail "could not read the service process tree; the job was not unloaded"
      tracked="$tracked $descendants"
    fi
    printf '%s\n' "$tracked" >"$STOP_PENDING"
    if ! sudo /bin/launchctl bootout "$TARGET"; then
      if read_job; then fail "bootout failed; the service remains loaded, retry stop"; fi
    fi
  fi
  deadline=$((SECONDS + EXIT_SECONDS + MAC_SERVICE_STOP_MARGIN_SECONDS))
  aporisa_log WAIT "Waiting for the job and its process tree to exit (up to $((EXIT_SECONDS + MAC_SERVICE_STOP_MARGIN_SECONDS))s)..."
  while :; do
    alive=0
    remaining=""
    job_loaded=0
    if read_job; then alive=1; job_loaded=1; fi
    for pid in $tracked; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; remaining="$remaining $pid"; fi
    done
    if [ "$alive" = 0 ]; then break; fi
    [ "$SECONDS" -lt "$deadline" ] ||
      fail "stop incomplete: job_loaded=$job_loaded remaining_pids=${remaining:-none}; no broad kill was attempted"
    sleep "$MAC_SERVICE_POLL_SECONDS"
  done
  read_autostart
  [ "$DISABLED" = true ] || fail "startup was not disabled; stop is not complete"
  rm -f -- "$STOP_PENDING"
  status_service
  [ "$SERVICE_STATE" = STOPPED ] || fail "the service state changed before stop completed"
  aporisa_log READY "Stopped and disabled; the installed plist is kept."
}

uninstall_service() {
  require_stopped
  [ ! -L "$GENERATED" ] || fail "the generated definition must not be a symlink"
  if [ -e "$INSTALLED" ] || [ -L "$INSTALLED" ]; then
    verify_installation
    sudo /bin/launchctl disable "$TARGET"
    unload_idle_job
    sudo /bin/rm -- "$INSTALLED"
  fi
  # Also finishes an interrupted uninstall whose system copy was already removed.
  rm -f -- "$GENERATED"
  rmdir "$GENERATED_DIR" 2>/dev/null || true
  status_service
  [ "$SERVICE_STATE" = UNINSTALLED ] || fail "the service state changed before uninstall completed"
  aporisa_log READY "Uninstalled $INSTALLED; repository, models, configuration and logs kept."
}

status_service() {
  SERVICE_STATE=UNKNOWN
  AUTOSTART=off
  aporisa_log INFO "Service: $LABEL"
  aporisa_log INFO "Definition: $INSTALLED"
  aporisa_log INFO "Console logs: $STATE_DIR/logs/"
  if [ -e "$STOP_PENDING" ]; then
    SERVICE_STATE=STOP_INCOMPLETE
    aporisa_log MANUAL "state=STOP_INCOMPLETE; run stop again and inspect the remaining processes."
    return 1
  fi
  if [ ! -e "$INSTALLED" ] && [ ! -L "$INSTALLED" ]; then
    if read_job; then fail "a registered job has no installed plist; manual inspection required"; fi
    SERVICE_STATE=UNINSTALLED
    aporisa_log INFO "state=UNINSTALLED installed=no registered=no autostart=off pid=none"
    return
  fi
  verify_installation
  read_autostart
  if ! read_job; then
    if [ "$AUTOSTART" = on ]; then
      SERVICE_STATE=REGISTRATION_MISSING
      aporisa_log MANUAL "state=REGISTRATION_MISSING installed=yes registered=no autostart=on pid=none"
      return 1
    fi
    SERVICE_STATE=STOPPED
    aporisa_log INFO "state=STOPPED installed=yes registered=no autostart=off pid=none"
    return
  fi
  if [ -z "$JOB_PID" ]; then
    if [ "$(field RunAtLoad "$INSTALLED")" = false ] && ! job_has_exited; then
      SERVICE_STATE=REGISTERED_IDLE
      aporisa_log INFO "state=REGISTERED_IDLE installed=yes registered=yes autostart=off pid=none"
      return
    fi
    SERVICE_STATE=FAILED
    aporisa_log MANUAL "state=FAILED installed=yes registered=yes autostart=$AUTOSTART pid=none; run stop before retrying"
    return 1
  fi
  load_port
  if healthy; then
    SERVICE_STATE=READY
    aporisa_log READY "state=READY installed=yes registered=yes autostart=$AUTOSTART pid=$JOB_PID"
  else
    SERVICE_STATE=NOT_READY
    aporisa_log WAIT "state=NOT_READY installed=yes registered=yes autostart=$AUTOSTART pid=$JOB_PID (starting or unhealthy)"
    return 1
  fi
}

case "$MODE" in install | start | stop | uninstall | restart | prepare) lock_control ;; esac
case "$MODE" in
  install) install_service ;;
  start) start_service ;;
  stop) stop_service ;;
  uninstall) uninstall_service ;;
  restart)
    stop_service
    start_service
    ;;
  status) status_service ;;
  doctor)
    preparation_failed=0
    state_failed=0
    environment_doctor || preparation_failed=1
    status_service || state_failed=1
    if [ "$preparation_failed" = 0 ] && [ "$state_failed" = 0 ]; then
      aporisa_log READY "Doctor passed; stopped, idle and uninstalled states are normal."
      exit 0
    fi
    if [ "$preparation_failed" != 0 ]; then
      aporisa_log INFO "Environment checks did not pass; follow the instructions above."
    fi
    if [ "$state_failed" != 0 ]; then
      aporisa_log INFO "The service state needs attention; prepare does not repair service registration."
    fi
    exit 1
    ;;
  prepare)
    require_stopped
    service_prerequisites
    env -u APORISA_API_KEY -u APORISA_BACKEND_PORT PATH="$SERVICE_PATH" "$PROJECT_ROOT/scripts/backend.sh" prepare
    status_service
    aporisa_log READY "Preparation and final checks passed; no service was started."
    ;;
esac
