#!/usr/bin/env bash
set -euo pipefail

VERSION="1.3.0"

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
CONTAINER=""
PARSER="plain"
SERVICE_NAME="$APP_NAME_DEFAULT"
HOST_TAG="$(hostname -f 2>/dev/null || hostname)"
BATCH_LINES="200"
FLUSH_SECS="2"
CURL_TIMEOUT_SECS="15"
OUTPUT="text"
DRY_RUN="false"
UNINSTALL="false"
INSTALL_DEPS="true"
SERVICE_TAG=""
ENVIRONMENT="production"

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
  --source-type pm2|nginx|apache|journald|file|docker|laravel|mysql|postgresql   (default: pm2)
  --log-glob GLOB
  --container NAME     Docker container name or ID (required for docker source)
  --parser plain|json|logfmt  Log line format for file/laravel sources (default: plain)
  --service-name NAME
  --host-tag TAG
  --batch-lines N          (default: 200)
  --flush-secs N           (default: 2)
  --curl-timeout-secs N    (default: 15)
  --service-tag NAME       service name shown in the UI (default: source type)
  --environment ENV        production|staging|dev (default: production)
  --output text|json
  --dry-run
  --uninstall
  --no-install-deps
  --help

Severity captured per source type:
  pm2/file     FATAL|ERROR|WARN|INFO|DEBUG|TRACE via keyword scan (or JSON parse with --parser json)
  nginx/apache INFO (1xx-3xx) WARN (4xx) ERROR (5xx) via HTTP status
  journald     FATAL (0-2) ERROR (3) WARN (4) INFO (5-6) DEBUG (7) via PRIORITY
  docker       Auto-detected JSON (level/severity/msg fields) or keyword scan
  laravel      Monolog JSON + plain-text format (level_name field or keyword)
  mysql        ERROR/WARNING/NOTE/INFO keywords from MySQL error log
  postgresql   FATAL/ERROR/WARNING/LOG/INFO keywords from PostgreSQL log
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
      --container)         CONTAINER="${2:-}"; shift 2 ;;
      --parser)            PARSER="${2:-plain}"; shift 2 ;;
      --service-name)      SERVICE_NAME="${2:-}"; shift 2 ;;
      --host-tag)          HOST_TAG="${2:-}"; shift 2 ;;
      --batch-lines)       BATCH_LINES="${2:-}"; shift 2 ;;
      --flush-secs)        FLUSH_SECS="${2:-}"; shift 2 ;;
      --curl-timeout-secs) CURL_TIMEOUT_SECS="${2:-}"; shift 2 ;;
      --service-tag)       SERVICE_TAG="${2:-}"; shift 2 ;;
      --environment)       ENVIRONMENT="${2:-}"; shift 2 ;;
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
    pm2)        [ -z "$LOG_GLOB" ] && LOG_GLOB="/home/ubuntu/.pm2/logs/*.log" ;;
    nginx)      [ -z "$LOG_GLOB" ] && LOG_GLOB="/var/log/nginx/*.log" ;;
    apache)     [ -z "$LOG_GLOB" ] && LOG_GLOB="$(detect_apache_log_glob)" ;;
    journald)   LOG_GLOB="" ;;
    file)       : ;;
    docker)     LOG_GLOB="" ;;  # uses docker logs, not file tail
    laravel)    [ -z "$LOG_GLOB" ] && LOG_GLOB="/var/www/html/storage/logs/*.log"; PARSER="json" ;;
    mysql)      [ -z "$LOG_GLOB" ] && LOG_GLOB="/var/log/mysql/error.log" ;;
    postgresql) [ -z "$LOG_GLOB" ] && LOG_GLOB="/var/log/postgresql/*.log" ;;
  esac
  [ -z "$SERVICE_TAG" ] && SERVICE_TAG="$SOURCE_TYPE"
}

validate_inputs() {
  case "$MODE" in
    file-tail|http-push|both) ;;
    *) json_error_and_exit "INVALID_MODE" "--mode must be: file-tail, http-push, or both" ;;
  esac
  case "$SOURCE_TYPE" in
    pm2|nginx|apache|journald|file|docker|laravel|mysql|postgresql) ;;
    *) json_error_and_exit "INVALID_SOURCE_TYPE" "--source-type must be: pm2, nginx, apache, journald, file, docker, laravel, mysql, postgresql" ;;
  esac
  case "$PARSER" in plain|json|logfmt) ;; *) json_error_and_exit "INVALID_PARSER" "--parser must be: plain, json, or logfmt" ;; esac
  case "$OUTPUT" in text|json) ;; *) json_error_and_exit "INVALID_OUTPUT" "--output must be text or json" ;; esac
  case "$ENVIRONMENT" in production|staging|dev) ;; *) json_error_and_exit "INVALID_ENV" "--environment must be: production, staging, or dev" ;; esac
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
    if [ "$SOURCE_TYPE" = "docker" ] && [ -z "$CONTAINER" ]; then
      json_error_and_exit "MISSING_CONTAINER" "--container is required when --source-type docker"
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

  # Auto-grant read access to log directories.
  # Strip glob chars to get the base directory, then find its owner and add
  # lumitrace-agent to that group so it can traverse and read the files.
  if [ -n "$LOG_GLOB" ]; then
    local log_dir
    log_dir="$(dirname "$LOG_GLOB" | tr -d '*?')"
    # Walk up until we find a directory that actually exists
    while [ -n "$log_dir" ] && [ "$log_dir" != "/" ] && [ ! -d "$log_dir" ]; do
      log_dir="$(dirname "$log_dir")"
    done
    if [ -d "$log_dir" ]; then
      local dir_owner
      dir_owner="$(stat -c '%U' "$log_dir" 2>/dev/null || true)"
      if [ -n "$dir_owner" ] && [ "$dir_owner" != "root" ] && [ "$dir_owner" != "$APP_USER_DEFAULT" ]; then
        if getent group "$dir_owner" >/dev/null 2>&1; then
          usermod -aG "$dir_owner" "$APP_USER_DEFAULT"
          slog "Added $APP_USER_DEFAULT to group '$dir_owner' for log access"
        fi
      fi
    fi
  fi
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
CONTAINER="$CONTAINER"
PARSER="$PARSER"
HOST_TAG="$HOST_TAG"
SERVICE_TAG="$SERVICE_TAG"
ENVIRONMENT="$ENVIRONMENT"
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
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
# Verify critical vars are present (set either by source or by systemd EnvironmentFile)
: "${INGEST_URL:?agent env missing INGEST_URL — re-run the install command}"
: "${INGEST_TOKEN:?agent env missing INGEST_TOKEN — re-run the install command}"
: "${SOURCE_TYPE:?agent env missing SOURCE_TYPE — re-run the install command}"

QUEUE_FILE="$DATA_DIR/queue.ndjson"
LOCK_FILE="$DATA_DIR/flush.lock"
mkdir -p "$DATA_DIR"
touch "$QUEUE_FILE"

slog() { printf '[shipper] %s\n' "$*" >&2; }

# ── severity helpers ──────────────────────────────────────────────────────────

# Keyword scan — covers pm2, bare file, Laravel plain text, MySQL, PostgreSQL
text_to_severity() {
  local line_lower
  line_lower="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  case "$line_lower" in
    *fatal*|*critical*|*emergency*|*alert*|*panic*) echo "FATAL" ;;
    *error*|*exception*|*stderr*)                    echo "ERROR" ;;
    *warn*|*warning*)                                echo "WARN"  ;;
    *debug*)                                         echo "DEBUG" ;;
    *trace*|*verbose*)                               echo "TRACE" ;;
    *)                                               echo "INFO"  ;;
  esac
}

# HTTP status → severity (nginx / apache combined log format)
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

# JSON/numeric level → severity
# Handles: pino/bunyan numbers (10/20/30/40/50/60),
#          Monolog numbers (100/200/300/400/500/600),
#          string labels from winston/logrus/zerolog/structlog
parse_json_level() {
  local raw_level="$1"
  case "$(echo "$raw_level" | tr '[:upper:]' '[:lower:]')" in
    fatal|critical|emergency|alert)  echo "FATAL" ; return ;;
    error)                           echo "ERROR" ; return ;;
    warn|warning)                    echo "WARN"  ; return ;;
    info)                            echo "INFO"  ; return ;;
    debug)                           echo "DEBUG" ; return ;;
    trace|verbose)                   echo "TRACE" ; return ;;
  esac
  # Numeric: pino/bunyan (10-60) and Monolog (100-600)
  if [[ "$raw_level" =~ ^[0-9]+$ ]]; then
    local n="$raw_level"
    if   [ "$n" -ge 550 ]; then echo "FATAL"
    elif [ "$n" -ge 400 ] || [ "$n" -eq 60 ]; then echo "ERROR"
    elif [ "$n" -ge 300 ] || [ "$n" -eq 40 ]; then echo "WARN"
    elif [ "$n" -ge 200 ] || [ "$n" -eq 30 ]; then echo "INFO"
    elif [ "$n" -ge 100 ] || [ "$n" -eq 20 ]; then echo "DEBUG"
    else echo "TRACE"
    fi
    return
  fi
  echo ""  # unknown — caller falls back to keyword scan
}

# ── structured log parsers ────────────────────────────────────────────────────

# Parse a JSON log line. Covers:
#   pino/bunyan  {"level":30,"time":1234567890,"msg":"hello"}
#   winston      {"level":"info","message":"hello","timestamp":"..."}
#   logrus/zerolog {"level":"error","msg":"hello","time":"..."}
#   structlog    {"event":"hello","level":"info","timestamp":"..."}
#   Monolog      {"message":"hello","level_name":"ERROR","datetime":"..."}
#   Docker       {"log":"hello\n","stream":"stdout","time":"..."}
json_line_structured() {
  local raw="$1"

  # Extract message — try each common field name in priority order
  local msg
  msg="$(echo "$raw" | jq -r '.message // .msg // .event // .log // empty' 2>/dev/null || true)"
  [ -z "$msg" ] && return 0
  msg="${msg%$'\n'}"  # strip trailing newline (Docker json-file driver)

  # Extract level — level_name (Monolog), level, severity, lvl
  local level_raw sev
  level_raw="$(echo "$raw" | jq -r '.level_name // .level // .severity // .lvl // empty' 2>/dev/null || true)"
  sev="$(parse_json_level "$level_raw")"
  # Fall back to keyword scan on the message text if level unrecognised
  [ -z "$sev" ] && sev="$(text_to_severity "$msg")"

  # Extract timestamp — try each common field; fall back to now
  local ts
  ts="$(echo "$raw" | jq -r '.time // .timestamp // .datetime // .ts // empty' 2>/dev/null || true)"
  # pino/bunyan emit time as epoch ms — convert if purely numeric
  if [[ "$ts" =~ ^[0-9]{10,}$ ]]; then
    ts="$(date -u -d "@$((ts / 1000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  [ -z "$ts" ] && ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Extract optional service name embedded in the JSON
  local svc
  svc="$(echo "$raw" | jq -r '.name // .service // .app // .logger // empty' 2>/dev/null || true)"
  [ -z "$svc" ] && svc="${SERVICE_TAG:-unknown}"

  jq -cn \
    --arg ts   "$ts" \
    --arg sev  "$sev" \
    --arg msg  "$msg" \
    --arg host "${HOST_TAG:-unknown}" \
    --arg src  "${SOURCE_TYPE:-file}" \
    --arg svc  "$svc" \
    --arg env  "${ENVIRONMENT:-production}" \
    --arg raw  "$raw" \
    '{ts:$ts,severity:$sev,message:$msg,raw:$raw,attributes:{host:$host,source_type:$src,service:$svc,environment:$env}}'
}

# Parse logfmt key=value lines:
#   level=info msg="hello world" ts=2024-01-01T00:00:00Z
json_line_logfmt() {
  local raw="$1"
  local ts sev msg

  # Extract key=value or key="value" pairs with awk
  msg="$(echo "$raw"  | awk '{for(i=1;i<=NF;i++){if($i~/^msg=|^message=/){sub(/^[^=]+=[""]?/,"",$i);gsub(/[""]$/,"",$i);print $i;exit}}}')"
  [ -z "$msg" ] && msg="$raw"

  local level_raw
  level_raw="$(echo "$raw" | awk '{for(i=1;i<=NF;i++){if($i~/^level=|^severity=|^lvl=/){sub(/^[^=]+=[""]?/,"",$i);gsub(/[""]$/,"",$i);print $i;exit}}}')"
  sev="$(parse_json_level "$level_raw")"
  [ -z "$sev" ] && sev="$(text_to_severity "$msg")"

  ts="$(echo "$raw" | awk '{for(i=1;i<=NF;i++){if($i~/^ts=|^time=|^timestamp=/){sub(/^[^=]+=[""]?/,"",$i);gsub(/[""]$/,"",$i);print $i;exit}}}')"
  [ -z "$ts" ] && ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  jq -cn \
    --arg ts   "$ts" \
    --arg sev  "$sev" \
    --arg msg  "$msg" \
    --arg host "${HOST_TAG:-unknown}" \
    --arg src  "${SOURCE_TYPE:-file}" \
    --arg svc  "${SERVICE_TAG:-unknown}" \
    --arg env  "${ENVIRONMENT:-production}" \
    --arg raw  "$raw" \
    '{ts:$ts,severity:$sev,message:$msg,raw:$raw,attributes:{host:$host,source_type:$src,service:$svc,environment:$env}}'
}

# ── line formatters ───────────────────────────────────────────────────────────

json_line_file() {
  local raw="$1"
  local ts sev sc_arg=""
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # JSON parser: explicit --parser json, laravel (always JSON/Monolog), or
  # docker (json-file log driver), or auto-detect JSON objects
  local effective_parser="${PARSER:-plain}"
  if [ "$SOURCE_TYPE" = "docker" ] || [ "$SOURCE_TYPE" = "laravel" ]; then
    effective_parser="json"
  fi

  if [ "$effective_parser" = "json" ] || [[ "$raw" =~ ^\{ ]]; then
    local result
    result="$(json_line_structured "$raw" 2>/dev/null || true)"
    [ -n "$result" ] && { echo "$result"; return; }
    # Fall through to keyword scan if JSON parsing fails
  fi

  if [ "$effective_parser" = "logfmt" ]; then
    local result
    result="$(json_line_logfmt "$raw" 2>/dev/null || true)"
    [ -n "$result" ] && { echo "$result"; return; }
  fi

  case "$SOURCE_TYPE" in
    nginx|apache)
      local sc
      sc="$(echo "$raw" | awk '{print $9}')"
      sev="$(http_status_to_severity "$sc")"
      [[ "$sc" =~ ^[0-9]+$ ]] && sc_arg="$sc"
      ;;
    mysql)
      # MySQL error log: "2024-01-15T10:30:00Z 0 [ERROR] ..."
      sev="$(echo "$raw" | grep -oP '\[(ERROR|WARNING|NOTE|SYSTEM|INFO)\]' | tr -d '[]' || true)"
      [ -z "$sev" ] && sev="$(text_to_severity "$raw")"
      ;;
    postgresql)
      # PostgreSQL: "2024-01-15 10:30:00 UTC [1234]: user@db FATAL:  ..."
      sev="$(echo "$raw" | grep -oP '(?<=: \w{1,20} )(FATAL|PANIC|ERROR|WARNING|LOG|INFO|DETAIL|NOTICE)' || true)"
      [ -z "$sev" ] && sev="$(text_to_severity "$raw")"
      # Normalise PostgreSQL labels
      case "$sev" in PANIC) sev="FATAL" ;; LOG|NOTICE|DETAIL) sev="INFO" ;; esac
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
      --arg  svc  "${SERVICE_TAG:-unknown}" \
      --arg  env  "${ENVIRONMENT:-production}" \
      --argjson sc "$sc_arg" \
      '{ts:$ts,severity:$sev,message:$msg,status_code:$sc,attributes:{host:$host,source_type:$src,service:$svc,environment:$env}}'
  else
    jq -cn \
      --arg ts  "$ts" \
      --arg sev "$sev" \
      --arg msg "$raw" \
      --arg host "${HOST_TAG:-unknown}" \
      --arg src  "${SOURCE_TYPE:-file}" \
      --arg svc  "${SERVICE_TAG:-unknown}" \
      --arg env  "${ENVIRONMENT:-production}" \
      '{ts:$ts,severity:$sev,message:$msg,attributes:{host:$host,source_type:$src,service:$svc,environment:$env}}'
  fi
}

json_line_journald() {
  local raw="$1"
  local msg priority ts_us svc ts sev

  msg="$(echo "$raw" | jq -r '.MESSAGE // empty' 2>/dev/null || true)"
  [ -z "$msg" ] && return 0

  priority="$(echo "$raw" | jq -r '.PRIORITY // "6"'                           2>/dev/null || echo "6")"
  ts_us="$(   echo "$raw" | jq -r '.__REALTIME_TIMESTAMP // ""'                 2>/dev/null || true)"
  svc="$(     echo "$raw" | jq -r '.SYSLOG_IDENTIFIER // ._SYSTEMD_UNIT // ""'  2>/dev/null || true)"

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
    --arg env  "${ENVIRONMENT:-production}" \
    '{ts:$ts,severity:$sev,message:$msg,attributes:{host:$host,source_type:"journald",service:$svc,environment:$env}}'
}

# ── flush ─────────────────────────────────────────────────────────────────────

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

# ── main dispatch ─────────────────────────────────────────────────────────────

periodic_flusher &

process_lines() {
  local line_count=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local result
    result="$("$1" "$line")" || continue
    [ -z "$result" ] && continue
    printf '%s\n' "$result" >> "$QUEUE_FILE"
    line_count=$((line_count + 1))
    if [ "$line_count" -ge "${BATCH_LINES:-200}" ]; then
      flush_queue || true
      line_count=0
    fi
  done
}

if [ "$SOURCE_TYPE" = "journald" ]; then
  slog "Starting journald tail (journalctl -f -o json -n 0)"
  journalctl -f -o json -n 0 | process_lines json_line_journald

elif [ "$SOURCE_TYPE" = "docker" ]; then
  CONTAINER="${CONTAINER:-}"
  [ -z "$CONTAINER" ] && { echo "[shipper][error] CONTAINER is not set" >&2; exit 1; }
  slog "Following Docker container: $CONTAINER"
  # --timestamps adds RFC3339 timestamp prefix; shipper strips it and uses JSON time field
  docker logs --follow --timestamps "$CONTAINER" 2>&1 | process_lines json_line_file

else
  tail_log_files() {
    while true; do
      mapfile -t files < <(compgen -G "$LOG_GLOB" 2>/dev/null || true)
      if [ "${#files[@]}" -eq 0 ]; then
        slog "No files match LOG_GLOB=$LOG_GLOB; retrying in 5s..."
        sleep 5
        continue
      fi
      slog "Tailing ${#files[@]} file(s) [source-type=$SOURCE_TYPE parser=${PARSER:-plain}]..."
      tail -n0 -F "${files[@]}" || true
      sleep 1
    done
  }

  tail_log_files | process_lines json_line_file
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
  [ "$SOURCE_TYPE" = "docker" ]   && extra_group="SupplementaryGroups=docker"

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
EnvironmentFile=-$env_file
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

  # Bake current values into the uninstall script so it works even if
  # the install directory is gone before the script finishes.
  cat > "$INSTALL_DIR_DEFAULT/uninstall.sh" <<EOF
#!/usr/bin/env bash
# lumitrace-agent uninstaller — generated by install.sh $VERSION
SVC="$SERVICE_NAME"
SVC_FILE="$service_file"
INSTALL_DIR="$INSTALL_DIR_DEFAULT"
CONFIG_DIR="$CONFIG_DIR_DEFAULT"
DATA_DIR="$DATA_DIR_DEFAULT"
APP_USER="$APP_USER_DEFAULT"
APP_GROUP="$APP_GROUP_DEFAULT"

[ "\${EUID:-\$(id -u)}" -eq 0 ] || { echo "Run as root or sudo." >&2; exit 1; }

echo "==> Stopping \$SVC service..."
systemctl stop "\$SVC" 2>/dev/null || true

echo "==> Disabling \$SVC service..."
systemctl disable "\$SVC" 2>/dev/null || true

echo "==> Removing service file: \$SVC_FILE"
rm -f "\$SVC_FILE"

echo "==> Reloading systemd daemon..."
systemctl daemon-reload 2>/dev/null || true

echo "==> Clearing failed state for \$SVC..."
systemctl reset-failed "\$SVC" 2>/dev/null || true

echo "==> Killing any remaining \$APP_USER processes..."
pkill -u "\$APP_USER" 2>/dev/null || true
sleep 1
# Force-kill if still running
pkill -9 -u "\$APP_USER" 2>/dev/null || true

echo "==> Removing install directory: \$INSTALL_DIR"
rm -rf "\$INSTALL_DIR"

echo "==> Removing config directory: \$CONFIG_DIR"
rm -rf "\$CONFIG_DIR"

echo "==> Removing data directory: \$DATA_DIR"
rm -rf "\$DATA_DIR"

echo "==> Removing user: \$APP_USER"
if id -u "\$APP_USER" >/dev/null 2>&1; then
  userdel -r "\$APP_USER" 2>/dev/null || userdel "\$APP_USER" 2>/dev/null || true
fi

echo "==> Removing group: \$APP_GROUP"
if getent group "\$APP_GROUP" >/dev/null 2>&1; then
  groupdel "\$APP_GROUP" 2>/dev/null || true
fi

echo ""
echo "✓ lumitrace-agent has been fully uninstalled."
echo "  You can now run the install command again for a fresh installation."
EOF
  chmod 750 "$INSTALL_DIR_DEFAULT/uninstall.sh"
  chown root:root "$INSTALL_DIR_DEFAULT/uninstall.sh"
}

do_uninstall() {
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

  slog "Stopping $SERVICE_NAME"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$service_file"
  systemctl daemon-reload || true
  systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true

  slog "Killing any remaining $APP_USER_DEFAULT processes"
  pkill -u "$APP_USER_DEFAULT" 2>/dev/null || true
  sleep 1
  pkill -9 -u "$APP_USER_DEFAULT" 2>/dev/null || true

  slog "Removing directories"
  rm -rf "$INSTALL_DIR_DEFAULT" "$CONFIG_DIR_DEFAULT" "$DATA_DIR_DEFAULT"

  slog "Removing user and group"
  if id -u "$APP_USER_DEFAULT" >/dev/null 2>&1; then
    userdel -r "$APP_USER_DEFAULT" 2>/dev/null || userdel "$APP_USER_DEFAULT" 2>/dev/null || true
  fi
  if getent group "$APP_GROUP_DEFAULT" >/dev/null 2>&1; then
    groupdel "$APP_GROUP_DEFAULT" 2>/dev/null || true
  fi

  slog "lumitrace-agent fully uninstalled"
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
