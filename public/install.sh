#!/usr/bin/env bash
set -euo pipefail

VERSION="1.2.0"

APP_NAME_DEFAULT="lumitrace-agent"
APP_USER_DEFAULT="lumitrace-agent"
APP_GROUP_DEFAULT="lumitrace-agent"
INSTALL_DIR_DEFAULT="/opt/lumitrace-agent"
CONFIG_DIR_DEFAULT="/etc/lumitrace-agent"
DATA_DIR_DEFAULT="/var/lib/lumitrace-agent"

MODE=""
SOURCE_TYPE="pm2"
INGEST_URL=""
INGEST_TOKEN=""
LOG_GLOB=""
SERVICE_NAME="$APP_NAME_DEFAULT"
HOST_TAG="$(hostname -f 2>/dev/null || hostname)"
BATCH_LINES="200"
FLUSH_SECS="2"
CURL_TIMEOUT_SECS="15"
OUTPUT="text"
DRY_RUN="false"
UNINSTALL="false"
INSTALL_DEPS="true"

FILE_TAIL_ENABLED="false"
FILE_TAIL_INSTALLED="false"
FILE_TAIL_STATUS="not_installed"
HTTP_PUSH_ENABLED="false"

print_help() {
  cat <<'EOF'
Lumitrace Agent Installer

Usage:
  install.sh --mode MODE --source-type TYPE --ingest-url URL --ingest-token TOKEN [options]

Required:
  --mode file-tail|http-push|both
  --ingest-url URL
  --ingest-token TOKEN

Optional:
  --source-type pm2|nginx|apache|journald|file   (default: pm2)
  --log-glob GLOB
  --service-name NAME
  --host-tag TAG
  --batch-lines N          (default: 200)
  --flush-secs N           (default: 2)
  --curl-timeout-secs N    (default: 15)
  --output text|json
  --dry-run
  --uninstall
  --no-install-deps
  --help

Severity captured per source type:
  pm2/file   FATAL|ERROR|WARN|INFO|DEBUG|TRACE via keyword scan
  nginx      INFO (1xx-3xx) WARN (4xx) ERROR (5xx) via HTTP status
  apache     same as nginx
  journald   FATAL (0-2) ERROR (3) WARN (4) INFO (5-6) DEBUG (7) via PRIORITY
EOF
}

slog()  { printf '[install] %s\n' "$*" >&2; }
warn()  { printf '[install][warn] %s\n' "$*" >&2; }

require_cmd() { command -v "$1" >/dev/null 2>&1; }
is_root()     { [ "${EUID:-$(id -u)}" -eq 0 ]; }

json_error_and_exit() {
  local code="$1" message="$2" hint="${3:-}"
  if [ "$OUTPUT" = "json" ] && require_cmd jq; then
    jq -n \
      --arg mode "${MODE:-unknown}" \
      --arg code "$code" \
      --arg message "$message" \
      --arg hint "$hint" \
      '{ok:false,mode:$mode,error:{code:$code,message:$message,hint:(if $hint=="" then null else $hint end)}}'
  else
    printf 'ERROR: %s\n' "$message" >&2
    [ -n "$hint" ] && printf 'HINT: %s\n' "$hint" >&2
  fi
  exit 1
}

detect_apache_log_glob() {
  if   [ -d "/var/log/apache2" ]; then echo "/var/log/apache2/*.log"
  elif [ -d "/var/log/httpd" ];   then echo "/var/log/httpd/*.log"
  else                                 echo "/var/log/apache2/*.log"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode)              MODE="${2:-}"; shift 2 ;;
      --source-type)       SOURCE_TYPE="${2:-}"; shift 2 ;;
      --ingest-url)        INGEST_URL="${2:-}"; shift 2 ;;
      --ingest-token)      INGEST_TOKEN="${2:-}"; shift 2 ;;
      --log-glob)          LOG_GLOB="${2:-}"; shift 2 ;;
      --service-name)      SERVICE_NAME="${2:-}"; shift 2 ;;
      --host-tag)          HOST_TAG="${2:-}"; shift 2 ;;
      --batch-lines)       BATCH_LINES="${2:-}"; shift 2 ;;
      --flush-secs)        FLUSH_SECS="${2:-}"; shift 2 ;;
      --curl-timeout-secs) CURL_TIMEOUT_SECS="${2:-}"; shift 2 ;;
      --output)            OUTPUT="${2:-}"; shift 2 ;;
      --dry-run)           DRY_RUN="true"; shift 1 ;;
      --uninstall)         UNINSTALL="true"; shift 1 ;;
      --no-install-deps)   INSTALL_DEPS="false"; shift 1 ;;
      --help|-h)           print_help; exit 0 ;;
      *)                   json_error_and_exit "INVALID_ARG" "Unknown argument: $1" "Run with --help" ;;
    esac
  done
}

set_source_defaults() {
  case "$SOURCE_TYPE" in
    pm2)      [ -z "$LOG_GLOB" ] && LOG_GLOB="/home/ubuntu/.pm2/logs/*.log" ;;
    nginx)    [ -z "$LOG_GLOB" ] && LOG_GLOB="/var/log/nginx/*.log" ;;
    apache)   [ -z "$LOG_GLOB" ] && LOG_GLOB="$(detect_apache_log_glob)" ;;
    journald) LOG_GLOB="" ;;
    file)     : ;;
  esac
}

validate_inputs() {
  case "$MODE" in
    file-tail|http-push|both) ;;
    *) json_error_and_exit "INVALID_MODE" "--mode must be: file-tail, http-push, or both" ;;
  esac
  case "$SOURCE_TYPE" in
    pm2|nginx|apache|journald|file) ;;
    *) json_error_and_exit "INVALID_SOURCE_TYPE" "--source-type must be: pm2, nginx, apache, journald, file" ;;
  esac
  case "$OUTPUT" in text|json) ;; *) json_error_and_exit "INVALID_OUTPUT" "--output must be text or json" ;; esac
  [ -z "$INGEST_URL" ]   && json_error_and_exit "MISSING_REQUIRED" "--ingest-url is required"
  [ -z "$INGEST_TOKEN" ] && json_error_and_exit "MISSING_REQUIRED" "--ingest-token is required"
  case "$INGEST_URL" in
    http://*|https://*) ;;
    *) json_error_and_exit "INVALID_URL" "--ingest-url must start with http:// or https://" ;;
  esac
  if [ "$MODE" != "http-push" ]; then
    if [ "$SOURCE_TYPE" = "file" ] && [ -z "$LOG_GLOB" ]; then
      json_error_and_exit "MISSING_LOG_GLOB" "--log-glob is required when --source-type file"
    fi
    is_root || json_error_and_exit "NEED_ROOT" "Run as root or with sudo"
  fi
}

detect_pm() {
  if require_cmd apt-get; then echo "apt"; return; fi
  if require_cmd dnf;     then echo "dnf"; return; fi
  if require_cmd yum;     then echo "yum"; return; fi
  echo "none"
}

install_packages() {
  [ "$INSTALL_DEPS" != "true" ] && return
  local pm; pm="$(detect_pm)"
  case "$pm" in
    apt)
      slog "Installing dependencies (apt)..."
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y ca-certificates curl jq coreutils util-linux
      ;;
    dnf) dnf install -y ca-certificates curl jq coreutils util-linux ;;
    yum) yum install -y ca-certificates curl jq coreutils util-linux ;;
    *)   warn "No supported package manager. Ensure curl, jq, flock are installed." ;;
  esac
}

check_runtime_requirements() {
  require_cmd curl || json_error_and_exit "MISSING_DEPENDENCY" "curl is required"
  [ "$OUTPUT" = "json" ] && { require_cmd jq || json_error_and_exit "MISSING_DEPENDENCY" "jq required for --output json"; }
  if [ "$MODE" != "http-push" ]; then
    require_cmd systemctl || json_error_and_exit "NO_SYSTEMD" "systemctl required"
    require_cmd jq        || json_error_and_exit "MISSING_DEPENDENCY" "jq required"
    if [ "$SOURCE_TYPE" = "journald" ]; then
      require_cmd journalctl || json_error_and_exit "MISSING_DEPENDENCY" "journalctl required"
    else
      require_cmd flock || json_error_and_exit "MISSING_DEPENDENCY" "flock required"
    fi
  fi
}

ensure_user_group() {
  if ! getent group "$APP_GROUP_DEFAULT" >/dev/null 2>&1; then groupadd --system "$APP_GROUP_DEFAULT"; fi
  if ! id -u "$APP_USER_DEFAULT" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP_DEFAULT" --home "$DATA_DIR_DEFAULT" --shell /usr/sbin/nologin "$APP_USER_DEFAULT"
  fi
  mkdir -p "$DATA_DIR_DEFAULT"
  chown "$APP_USER_DEFAULT:$APP_GROUP_DEFAULT" "$DATA_DIR_DEFAULT"
  chmod 750 "$DATA_DIR_DEFAULT"
}

write_env_file() {
  local env_file="$CONFIG_DIR_DEFAULT/agent.env"
  mkdir -p "$CONFIG_DIR_DEFAULT"
  chmod 750 "$CONFIG_DIR_DEFAULT"
  cat > "$env_file" <<EOF
INGEST_URL="$INGEST_URL"
INGEST_TOKEN="$INGEST_TOKEN"
SOURCE_TYPE="$SOURCE_TYPE"
LOG_GLOB="$LOG_GLOB"
HOST_TAG="$HOST_TAG"
BATCH_LINES="$BATCH_LINES"
FLUSH_SECS="$FLUSH_SECS"
CURL_TIMEOUT_SECS="$CURL_TIMEOUT_SECS"
DATA_DIR="$DATA_DIR_DEFAULT"
EOF
  chmod 640 "$env_file"
  chown root:"$APP_GROUP_DEFAULT" "$env_file"
}

write_shipper() {
  mkdir -p "$INSTALL_DIR_DEFAULT"
  chmod 755 "$INSTALL_DIR_DEFAULT"

  cat > "$INSTALL_DIR_DEFAULT/shipper.sh" <<'SHIPPER'
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/etc/lumitrace-agent/agent.env"
[ -f "$ENV_FILE" ] || { echo "[shipper][error] missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

QUEUE_FILE="$DATA_DIR/queue.ndjson"
LOCK_FILE="$DATA_DIR/flush.lock"
mkdir -p "$DATA_DIR"
touch "$QUEUE_FILE"

slog() { printf '[shipper] %s\n' "$*" >&2; }

# ── severity helpers ─────────────────────────────────────────────────────────

# Keyword scan for unstructured lines (pm2, generic file)
text_to_severity() {
  local line_lower
  line_lower="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  case "$line_lower" in
    *fatal*)                      echo "FATAL" ;;
    *error*|*exception*|*panic*)  echo "ERROR" ;;
    *warn*|*warning*)             echo "WARN"  ;;
    *debug*)                      echo "DEBUG" ;;
    *trace*|*verbose*)            echo "TRACE" ;;
    *)                            echo "INFO"  ;;
  esac
}

# HTTP status code → severity (nginx / apache combined log format)
http_status_to_severity() {
  local code="${1:-0}"
  if [[ "$code" =~ ^[0-9]+$ ]]; then
    if   [ "$code" -ge 500 ]; then echo "ERROR"
    elif [ "$code" -ge 400 ]; then echo "WARN"
    else                           echo "INFO"
    fi
  else
    echo "INFO"
  fi
}

# journald syslog PRIORITY (0-7) → severity
journald_priority_to_severity() {
  case "${1:-6}" in
    0|1|2) echo "FATAL" ;;
    3)     echo "ERROR" ;;
    4)     echo "WARN"  ;;
    5|6)   echo "INFO"  ;;
    7)     echo "DEBUG" ;;
    *)     echo "INFO"  ;;
  esac
}

# ── line formatters ──────────────────────────────────────────────────────────

json_line_file() {
  local raw="$1"
  local ts sev sc_arg=""
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  case "$SOURCE_TYPE" in
    nginx|apache)
      local sc
      sc="$(echo "$raw" | awk '{print $9}')"
      sev="$(http_status_to_severity "$sc")"
      [[ "$sc" =~ ^[0-9]+$ ]] && sc_arg="$sc"
      ;;
    *)
      sev="$(text_to_severity "$raw")"
      ;;
  esac

  if [ -n "$sc_arg" ]; then
    jq -cn \
      --arg  ts   "$ts" \
      --arg  sev  "$sev" \
      --arg  msg  "$raw" \
      --arg  host "${HOST_TAG:-unknown}" \
      --arg  src  "${SOURCE_TYPE:-file}" \
      --argjson sc "$sc_arg" \
      '{ts:$ts,severity:$sev,message:$msg,status_code:$sc,attributes:{host:$host,source_type:$src}}'
  else
    jq -cn \
      --arg ts  "$ts" \
      --arg sev "$sev" \
      --arg msg "$raw" \
      --arg host "${HOST_TAG:-unknown}" \
      --arg src  "${SOURCE_TYPE:-file}" \
      '{ts:$ts,severity:$sev,message:$msg,attributes:{host:$host,source_type:$src}}'
  fi
}

json_line_journald() {
  local raw="$1"
  local msg priority ts_us svc ts sev

  msg="$(echo "$raw" | jq -r '.MESSAGE // empty' 2>/dev/null || true)"
  [ -z "$msg" ] && return 0

  priority="$(echo "$raw" | jq -r '.PRIORITY // "6"'                          2>/dev/null || echo "6")"
  ts_us="$(   echo "$raw" | jq -r '.__REALTIME_TIMESTAMP // ""'                2>/dev/null || true)"
  svc="$(     echo "$raw" | jq -r '.SYSLOG_IDENTIFIER // ._SYSTEMD_UNIT // ""' 2>/dev/null || true)"

  if [ -n "$ts_us" ] && [[ "$ts_us" =~ ^[0-9]+$ ]]; then
    ts="$(date -u -d "@$((ts_us / 1000000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  sev="$(journald_priority_to_severity "$priority")"

  jq -cn \
    --arg ts   "$ts" \
    --arg sev  "$sev" \
    --arg msg  "$msg" \
    --arg host "${HOST_TAG:-unknown}" \
    --arg svc  "$svc" \
    '{ts:$ts,severity:$sev,message:$msg,attributes:{host:$host,source_type:"journald",service:$svc}}'
}

# ── flush ────────────────────────────────────────────────────────────────────

flush_queue() {
  (
    flock -n 9 || exit 0
    [ -s "$QUEUE_FILE" ] || exit 0

    local payload
    payload="$(mktemp "$DATA_DIR/payload.XXXXXX.ndjson")"
    mv "$QUEUE_FILE" "$payload"
    touch "$QUEUE_FILE"

    if curl -fsS \
        --connect-timeout "${CURL_TIMEOUT_SECS:-15}" \
        --max-time "${CURL_TIMEOUT_SECS:-15}" \
        -X POST "$INGEST_URL" \
        -H "Authorization: Bearer $INGEST_TOKEN" \
        -H "Content-Type: application/x-ndjson" \
        --data-binary "@$payload" >/dev/null; then
      rm -f "$payload"
    else
      cat "$payload" >> "$QUEUE_FILE"
      rm -f "$payload"
      sleep 1
    fi
  ) 9>"$LOCK_FILE"
}

periodic_flusher() {
  while true; do
    sleep "${FLUSH_SECS:-2}"
    flush_queue || true
  done
}

cleanup() { flush_queue || true; }
trap cleanup EXIT INT TERM

# ── main dispatch ────────────────────────────────────────────────────────────

periodic_flusher &

if [ "$SOURCE_TYPE" = "journald" ]; then
  slog "Starting journald tail (journalctl -f -o json -n 0)"
  line_count=0

  journalctl -f -o json -n 0 | while IFS= read -r line; do
    result="$(json_line_journald "$line")" || continue
    [ -z "$result" ] && continue
    printf '%s\n' "$result" >> "$QUEUE_FILE"
    line_count=$((line_count + 1))
    if [ "$line_count" -ge "${BATCH_LINES:-200}" ]; then
      flush_queue || true
      line_count=0
    fi
  done

else
  tail_log_files() {
    while true; do
      mapfile -t files < <(compgen -G "$LOG_GLOB" 2>/dev/null || true)
      if [ "${#files[@]}" -eq 0 ]; then
        slog "No files match LOG_GLOB=$LOG_GLOB; retrying in 5s..."
        sleep 5
        continue
      fi
      slog "Tailing ${#files[@]} file(s) [source-type=$SOURCE_TYPE]..."
      tail -n0 -F "${files[@]}" || true
      sleep 1
    done
  }

  line_count=0
  tail_log_files | while IFS= read -r line; do
    result="$(json_line_file "$line")" || continue
    [ -z "$result" ] && continue
    printf '%s\n' "$result" >> "$QUEUE_FILE"
    line_count=$((line_count + 1))
    if [ "$line_count" -ge "${BATCH_LINES:-200}" ]; then
      flush_queue || true
      line_count=0
    fi
  done
fi
SHIPPER

  chmod 750 "$INSTALL_DIR_DEFAULT/shipper.sh"
  chown root:"$APP_GROUP_DEFAULT" "$INSTALL_DIR_DEFAULT/shipper.sh"
}

write_service() {
  local env_file="$CONFIG_DIR_DEFAULT/agent.env"
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  local extra_group=""
  [ "$SOURCE_TYPE" = "journald" ] && extra_group="SupplementaryGroups=systemd-journal"

  cat > "$service_file" <<EOF
[Unit]
Description=Lumitrace ${SOURCE_TYPE} log shipper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER_DEFAULT
Group=$APP_GROUP_DEFAULT
${extra_group}
EnvironmentFile=$env_file
ExecStart=$INSTALL_DIR_DEFAULT/shipper.sh
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=$DATA_DIR_DEFAULT
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$service_file"
}

write_uninstaller() {
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

  cat > "$INSTALL_DIR_DEFAULT/uninstall.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\${EUID:-\$(id -u)}" -eq 0 ] || { echo "Run as root or sudo." >&2; exit 1; }
systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
rm -f "$service_file"
systemctl daemon-reload || true
rm -rf "$INSTALL_DIR_DEFAULT" "$CONFIG_DIR_DEFAULT" "$DATA_DIR_DEFAULT"
if id -u "$APP_USER_DEFAULT" >/dev/null 2>&1; then userdel "$APP_USER_DEFAULT" || true; fi
if getent group "$APP_GROUP_DEFAULT" >/dev/null 2>&1; then groupdel "$APP_GROUP_DEFAULT" || true; fi
echo "Uninstalled $SERVICE_NAME"
EOF
  chmod 750 "$INSTALL_DIR_DEFAULT/uninstall.sh"
  chown root:root "$INSTALL_DIR_DEFAULT/uninstall.sh"
}

do_uninstall() {
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  slog "Stopping $SERVICE_NAME"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$service_file"
  systemctl daemon-reload || true
  rm -rf "$INSTALL_DIR_DEFAULT" "$CONFIG_DIR_DEFAULT" "$DATA_DIR_DEFAULT"
  if id -u "$APP_USER_DEFAULT" >/dev/null 2>&1; then userdel "$APP_USER_DEFAULT" || true; fi
  if getent group "$APP_GROUP_DEFAULT" >/dev/null 2>&1; then groupdel "$APP_GROUP_DEFAULT" || true; fi
}

install_file_tail() {
  FILE_TAIL_ENABLED="true"
  if [ "$DRY_RUN" = "true" ]; then
    slog "[dry-run] would install systemd service for source-type=$SOURCE_TYPE"
    FILE_TAIL_STATUS="dry_run"
    return
  fi
  ensure_user_group
  write_env_file
  write_shipper
  write_service
  write_uninstaller
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    FILE_TAIL_STATUS="active"
    FILE_TAIL_INSTALLED="true"
  else
    FILE_TAIL_STATUS="degraded"
    FILE_TAIL_INSTALLED="true"
    warn "Service started but not active — check: journalctl -u $SERVICE_NAME -n 20"
  fi
}

emit_result() {
  local sample_curl="curl -X POST '$INGEST_URL' -H 'Authorization: Bearer $INGEST_TOKEN' -H 'Content-Type: application/x-ndjson' --data-binary \$'{\"severity\":\"INFO\",\"message\":\"test\"}\n'"

  if [ "$OUTPUT" = "json" ]; then
    jq -n \
      --arg mode       "$MODE" \
      --arg version    "$VERSION" \
      --arg sourceType "$SOURCE_TYPE" \
      --arg svcName    "$SERVICE_NAME" \
      --arg logGlob    "${LOG_GLOB:-}" \
      --arg ftEnabled  "$FILE_TAIL_ENABLED" \
      --arg ftDone     "$FILE_TAIL_INSTALLED" \
      --arg ftStatus   "$FILE_TAIL_STATUS" \
      --arg httpOn     "$HTTP_PUSH_ENABLED" \
      --arg url        "$INGEST_URL" \
      --arg authHdr    "Authorization: Bearer $INGEST_TOKEN" \
      --arg sample     "$sample_curl" \
      '{
        ok: true, mode: $mode, version: $version, sourceType: $sourceType,
        fileTail: {
          enabled: ($ftEnabled=="true"), installed: ($ftDone=="true"),
          serviceStatus: $ftStatus, serviceName: $svcName, logGlob: $logGlob
        },
        httpPush: {
          enabled: ($httpOn=="true"), ingestUrl: $url,
          authHeader: $authHdr, sampleCurl: $sample
        },
        nextSteps: [
          ("systemctl status " + $svcName + " --no-pager"),
          ("journalctl -u " + $svcName + " -f"),
          ("/opt/lumitrace-agent/uninstall.sh")
        ]
      }'
  else
    printf '\nInstall complete | mode=%s source-type=%s version=%s\n' "$MODE" "$SOURCE_TYPE" "$VERSION"
    if [ "$FILE_TAIL_ENABLED" = "true" ]; then
      printf 'Service: %s (%s)\n' "$SERVICE_NAME" "$FILE_TAIL_STATUS"
      [ -n "${LOG_GLOB:-}" ] && printf 'Log glob: %s\n' "$LOG_GLOB"
      printf 'Logs:      journalctl -u %s -f\n' "$SERVICE_NAME"
      printf 'Uninstall: sudo /opt/lumitrace-agent/uninstall.sh\n'
    fi
    if [ "$HTTP_PUSH_ENABLED" = "true" ]; then
      printf '\nHTTP push ingest URL: %s\n' "$INGEST_URL"
      printf 'Sample: %s\n' "$sample_curl"
    fi
  fi
}

main() {
  parse_args "$@"
  set_source_defaults
  validate_inputs

  if [ "$UNINSTALL" = "true" ]; then
    do_uninstall
    if [ "$OUTPUT" = "json" ]; then
      jq -n --arg svc "$SERVICE_NAME" '{ok:true,action:"uninstall",service:$svc,status:"removed"}'
    else
      printf 'Uninstalled %s\n' "$SERVICE_NAME"
    fi
    exit 0
  fi

  [ "$MODE" = "http-push" ] || [ "$MODE" = "both" ] && HTTP_PUSH_ENABLED="true"

  if [ "$MODE" != "http-push" ]; then
    install_packages
    check_runtime_requirements
    install_file_tail
  else
    check_runtime_requirements
  fi

  emit_result
}

main "$@"
