#!/usr/bin/env python3
"""Safe helper for stable/test Hawk approval callbacks.

The script intentionally contains no credentials and no default provider
addresses. Credentials come from environment variables, or from the local
get-browser-session snapshot; target providers are passed explicitly or via a
local target file.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import dataclasses
import getpass
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:
    import requests
except ImportError as exc:  # pragma: no cover - import failure is environment-specific
    raise SystemExit("Missing dependency: requests. Install it in the active Python environment.") from exc


DEFAULT_LXCLOUD_URL = "https://stable-lxcloud.oa.fenqile.com/v1/mysql/sql-query/exec-query/"
DEFAULT_BIANQUE_URL = "https://stable-bianque.lexinfintech.com/serviceEmulator/request"
DEFAULT_TARGET_FILE = "~/.config/hawk-stable-approval/targets.json"
DEFAULT_SESSION_FILE = "~/.cache/agent-tools-session/stable-lxcloud.json"
BROWSER_SESSION_SCRIPT = "/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js"
LXCLOUD_ORIGIN = "https://stable-lxcloud.oa.fenqile.com"
BIANQUE_COOKIE_DOMAIN = "stable-bianque.lexinfintech.com"
LOGIC_ID_RE = re.compile(r"^[A-Za-z0-9_@-]+$")
NUMERIC_ID_RE = re.compile(r"^\d+$")


class UserError(Exception):
    """Raised for actionable user input or environment errors."""


@dataclasses.dataclass(frozen=True)
class SourceConfig:
    scope: str
    source: str
    label: str
    db_type: str
    table: str
    supports_oper_type: bool


@dataclasses.dataclass(frozen=True)
class CallbackRoute:
    key: str
    service: str
    target_key: str
    comment: str


@dataclasses.dataclass(frozen=True)
class Credentials:
    token: str = ""
    cookie: str = ""
    oa_user: str = ""


@dataclasses.dataclass(frozen=True)
class Target:
    ip: str
    port: str
    group: str = "stable"
    version: str = "1.0.0"


@dataclasses.dataclass
class ApprovalRecord:
    scope: str
    source: str
    logic_id: str
    approval_state: str
    modify_time: str
    oper_type: str
    plan_id: str
    package_id: str
    package_name: str
    publish_type: str
    publish_mode: str
    applicant: str
    approval_operator: str
    business_type: str
    summary: str
    raw: Mapping[str, Any]


SOURCE_CONFIGS: Mapping[Tuple[str, str], SourceConfig] = {
    ("domestic", "hawk"): SourceConfig(
        scope="domestic",
        source="hawk",
        label="米霍克审批",
        db_type="HawkDecisionDB",
        table="hawkeye_decision_engine_db.t_hawk_approval",
        supports_oper_type=True,
    ),
    ("domestic", "process"): SourceConfig(
        scope="domestic",
        source="process",
        label="流程引擎审批",
        db_type="ProcessmanageDB",
        table="process_engine_db.t_approval",
        supports_oper_type=False,
    ),
    ("mexico", "hawk"): SourceConfig(
        scope="mexico",
        source="hawk",
        label="墨西哥米霍克审批",
        db_type="MxgHawkDecisionDB",
        table="hawkeye_decision_engine_db.t_hawk_approval",
        supports_oper_type=True,
    ),
    ("mexico", "process"): SourceConfig(
        scope="mexico",
        source="process",
        label="墨西哥流程引擎审批",
        db_type="MxgProcessmanageDB",
        table="process_engine_db.t_approval",
        supports_oper_type=False,
    ),
    ("indonesia", "hawk"): SourceConfig(
        scope="indonesia",
        source="hawk",
        label="印尼米霍克审批",
        db_type="YnHawkDecisionDB",
        table="hawkeye_decision_engine_db.t_hawk_approval",
        supports_oper_type=True,
    ),
    ("indonesia", "process"): SourceConfig(
        scope="indonesia",
        source="process",
        label="印尼流程引擎审批",
        db_type="YnProcessmanageDB",
        table="process_engine_db.t_approval",
        supports_oper_type=False,
    ),
}

# `overseas` used to mean Mexico only; keep it working as an alias.
SCOPE_ALIASES: Mapping[str, str] = {"overseas": "mexico"}
SCOPE_CHOICES = ["domestic", "mexico", "indonesia", "overseas"]

ROUTES: Mapping[str, CallbackRoute] = {
    "hawk_manage": CallbackRoute(
        key="hawk_manage",
        service="com.fenqile.rc_comm.hawk.decision.manage.service.ApprovalCallBackService",
        target_key="hawk_manage",
        comment="米霍克审批通过",
    ),
    "hawk_process_publish": CallbackRoute(
        key="hawk_process_publish",
        service="com.fenqile.rc_comm.hawk.decision.manage.service.approval.ProcessApprovalCallbackService",
        target_key="hawk_process_publish",
        comment="米霍克流程发布审批通过",
    ),
    "process_engine": CallbackRoute(
        key="process_engine",
        service="com.fenqile.process.engine.console.service.approval.ApprovalCallBackService",
        target_key="process_engine",
        comment="流程引擎审批通过",
    ),
}


def field(row: Mapping[str, Any], name: str, default: str = "") -> str:
    for key in (name, name.lower(), name.upper()):
        value = row.get(key)
        if value is not None:
            return str(value)
    return default


def first_field(row: Mapping[str, Any], names: Sequence[str], default: str = "") -> str:
    for name in names:
        value = field(row, name)
        if value != "":
            return value
    return default


def compact_text(value: str, limit: int = 80) -> str:
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def table_namespace(table: str) -> str:
    if "." not in table:
        return ""
    return table.rsplit(".", 1)[0]


def business_type_for(source: str, oper_type: str) -> str:
    if source == "process":
        return "流程引擎审批"
    mapping = {
        "0": "乐包发布",
        "1": "流程发布",
        "2": "公共策略节点发布",
    }
    return mapping.get(oper_type, f"米霍克审批({oper_type})")


def split_logic_ids(values: Optional[Sequence[str]]) -> List[str]:
    if not values:
        return []
    logic_ids: List[str] = []
    for value in values:
        for item in value.split(","):
            item = item.strip()
            if not item:
                continue
            if not LOGIC_ID_RE.match(item):
                raise UserError(f"Invalid logic_id {item!r}; only letters, digits, underscore, hyphen and '@' are allowed.")
            logic_ids.append(item)
    return list(dict.fromkeys(logic_ids))


def split_numeric_ids(values: Optional[Sequence[str]], label: str) -> List[str]:
    if not values:
        return []
    ids: List[str] = []
    for value in values:
        for item in value.split(","):
            item = item.strip()
            if not item:
                continue
            if not NUMERIC_ID_RE.match(item):
                raise UserError(f"Invalid {label} {item!r}; only digits are allowed.")
            ids.append(item)
    return list(dict.fromkeys(ids))


def resolve_scope(scope: str) -> str:
    return SCOPE_ALIASES.get(scope, scope)


def selected_source_configs(scope: str, source: str) -> List[SourceConfig]:
    scope = resolve_scope(scope)
    source_names = ("hawk", "process") if source == "all" else (source,)
    return [SOURCE_CONFIGS[(scope, item)] for item in source_names]


def sql_literal(value: str) -> str:
    if not LOGIC_ID_RE.match(value):
        raise UserError(f"Unsafe SQL literal for logic_id: {value!r}")
    return "'" + value.replace("'", "''") + "'"


def build_where_clause(alias: str, pending: bool, logic_ids: Sequence[str], since_today: bool) -> str:
    prefix = f"{alias}." if alias else ""
    clauses = ["1=1"]
    if pending:
        clauses.append(f"{prefix}Fapproval_state = 10")
    if logic_ids:
        values = ",".join(sql_literal(item) for item in logic_ids)
        clauses.append(f"{prefix}Flogic_id in ({values})")
    if since_today:
        clauses.append(f"{prefix}Fmodify_time >= CURDATE()")
    return " and ".join(clauses)


def build_sql(
    config: SourceConfig,
    pending: bool,
    logic_ids: Sequence[str],
    since_today: bool,
    limit: int,
    package_ids: Sequence[str] = (),
    plan_ids: Sequence[str] = (),
) -> str:
    if config.source == "hawk":
        namespace = table_namespace(config.table)
        publish_plan_table = f"{namespace}.t_edition_publish_plan" if namespace else "t_edition_publish_plan"
        package_table = f"{namespace}.t_package" if namespace else "t_package"
        where_clause = build_where_clause("tha", pending, logic_ids, since_today)
        # lxcloud truncates at 100 rows, so business filters have to run in SQL, not after the fetch.
        if package_ids:
            where_clause += f" and tepp.Fpackage_id in ({','.join(package_ids)})"
        if plan_ids:
            where_clause += f" and tha.Fplan_id in ({','.join(plan_ids)})"
        sql = (
            "select tha.*, "
            "tepp.Fpackage_id as Fplan_package_id, "
            "tp.Fpackage_name as Fpackage_name, "
            "tepp.Fpublish_type as Fpublish_type, "
            "tepp.Fpublish_mode as Fpublish_mode, "
            "tepp.Foperator as Fapply_operator "
            f"from {config.table} tha "
            f"left join {publish_plan_table} tepp on tha.Fplan_id = tepp.Fplan_id "
            f"left join {package_table} tp on tp.Fpackage_id = tepp.Fpackage_id "
            f"where {where_clause} order by tha.Fmodify_time desc"
        )
    else:
        if package_ids or plan_ids:
            raise UserError("--package-id/--plan-id apply to --source hawk only; t_approval has no publish plan join.")
        where_clause = build_where_clause("", pending, logic_ids, since_today)
        sql = f"select * from {config.table} where {where_clause} order by Fmodify_time desc"
    if limit > 0:
        sql += f" limit {limit}"
    return sql


_CREDENTIALS: Optional[Credentials] = None


def jwt_claims(token: str) -> Tuple[str, Optional[int]]:
    """Read sub/exp from a JWT without verifying it; returns ("", None) when unreadable."""
    parts = token.split()[-1].split(".") if token else []
    if len(parts) != 3:
        return "", None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, binascii.Error):
        return "", None
    if not isinstance(claims, Mapping):
        return "", None
    exp = claims.get("exp")
    return str(claims.get("sub") or ""), int(exp) if isinstance(exp, (int, float)) else None


def token_is_usable(token: str) -> bool:
    if not token:
        return False
    _, exp = jwt_claims(token)
    if exp is None:
        return True  # opaque tokens cannot be checked locally; let the request decide
    return exp - 120 > time.time()


def read_session_snapshot(path: Path) -> Credentials:
    """Read the stable lxcloud token and stable bianque cookie from a get-browser-session snapshot."""
    if not path.is_file():
        return Credentials()
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Credentials()
    token = ""
    for origin in snapshot.get("origins", []):
        if str(origin.get("origin", "")).startswith(LXCLOUD_ORIGIN):
            for item in origin.get("localStorage", []):
                if item.get("name") == "token" and item.get("value"):
                    token = str(item["value"])
    cookies: Dict[str, str] = {}
    for cookie in snapshot.get("cookies", []):
        if cookie.get("domain") == BIANQUE_COOKIE_DOMAIN and cookie.get("name"):
            cookies[str(cookie["name"])] = str(cookie.get("value", ""))
    subject, _ = jwt_claims(token)
    return Credentials(token=token, cookie="; ".join(f"{k}={v}" for k, v in cookies.items()), oa_user=subject)


def refresh_session_snapshot(path: Path, timeout: int) -> None:
    """Refresh the snapshot via get-browser-session; secrets land in the 0600 file, never in output."""
    script = Path(BROWSER_SESSION_SCRIPT)
    if not script.is_file():
        raise UserError(f"Browser session script not found: {script}. Export LXCLOUD_BEARER_TOKEN and BIANQUE_COOKIE instead.")
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Refreshing browser session snapshot for {LXCLOUD_ORIGIN} ...", file=sys.stderr)
    completed = subprocess.run(
        ["node", str(script), f"--export-session={path}", f"--url={LXCLOUD_ORIGIN}/", "--success-text=none"],
        capture_output=True,
        text=True,
        timeout=max(timeout, 180),
    )
    if completed.returncode != 0:
        raise UserError(
            "Browser session export failed. Run get-browser-session with --ensure against "
            f"{LXCLOUD_ORIGIN}/ and retry."
        )


def resolve_credentials(args: argparse.Namespace) -> Credentials:
    """Environment first, then the local browser-session snapshot, refreshing it only when stale."""
    global _CREDENTIALS
    if _CREDENTIALS is not None:
        return _CREDENTIALS
    token = os.environ.get("LXCLOUD_BEARER_TOKEN", "").strip()
    cookie = os.environ.get("BIANQUE_COOKIE", "").strip()
    subject, _ = jwt_claims(token)
    if not (token and cookie) and not args.no_browser_session:
        path = Path(args.session_file).expanduser()
        snapshot = read_session_snapshot(path)
        if not token_is_usable(snapshot.token) or not snapshot.cookie:
            refresh_session_snapshot(path, args.timeout)
            snapshot = read_session_snapshot(path)
        token = token or snapshot.token
        cookie = cookie or snapshot.cookie
        subject = subject or snapshot.oa_user
    _CREDENTIALS = Credentials(token=token, cookie=cookie, oa_user=subject)
    return _CREDENTIALS


def resolve_user_name(args: argparse.Namespace) -> str:
    """OA account decides instance permission, so prefer the token subject over the local user."""
    return args.user_name or resolve_credentials(args).oa_user or getpass.getuser()


def offline_token_available(args: argparse.Namespace) -> bool:
    if os.environ.get("LXCLOUD_BEARER_TOKEN", "").strip():
        return True
    if args.no_browser_session:
        return False
    return bool(read_session_snapshot(Path(args.session_file).expanduser()).token)


def lxcloud_headers(args: argparse.Namespace) -> Dict[str, str]:
    token = resolve_credentials(args).token
    if not token:
        raise UserError(
            "No lxcloud credential. Export LXCLOUD_BEARER_TOKEN, or drop --no-browser-session so the "
            "local browser session can provide it."
        )
    if not token.lower().startswith("bearer "):
        token = "Bearer " + token

    headers = {
        "accept": "application/json, text/plain, */*",
        "authorization": token,
        "content-type": "application/json",
    }
    cookie = os.environ.get("LXCLOUD_COOKIE", "").strip()
    if cookie:
        headers["cookie"] = cookie
    mid = os.environ.get("LXCLOUD_MID", "").strip()
    if mid:
        headers["mid"] = mid
    return headers


def query_lxcloud(args: argparse.Namespace, config: SourceConfig, pending: bool, logic_ids: Sequence[str]) -> List[Mapping[str, Any]]:
    sql = build_sql(
        config=config,
        pending=pending,
        logic_ids=logic_ids,
        since_today=(not args.all_dates and pending),
        limit=args.limit,
        package_ids=split_numeric_ids(args.package_id, "package id"),
        plan_ids=split_numeric_ids(args.plan_id, "plan id"),
    )
    payload = {
        "db_type": config.db_type,
        "user_name": resolve_user_name(args),
        "sql": sql,
        "query_type": args.query_type,
        "query_role": args.query_role,
        "start_set": "",
        "end_set": "",
    }
    if args.print_sql:
        print(f"[SQL][{config.scope}/{config.source}] {sql}", file=sys.stderr)

    response = requests.post(args.lxcloud_url, headers=lxcloud_headers(args), json=payload, timeout=args.timeout)
    response.raise_for_status()
    body = response.json()
    return rows_from_lxcloud_response(body)


def rows_from_lxcloud_response(body: Any) -> List[Mapping[str, Any]]:
    if isinstance(body, list):
        return [row for row in body if isinstance(row, Mapping)]
    if not isinstance(body, Mapping):
        raise UserError("Unexpected lxcloud response: response is not an object or array.")
    data = body.get("data")
    if isinstance(data, Mapping) and isinstance(data.get("data"), list):
        return [row for row in data["data"] if isinstance(row, Mapping)]
    if isinstance(body.get("data"), list):
        return [row for row in body["data"] if isinstance(row, Mapping)]
    raise UserError("Unexpected lxcloud response: cannot find data.data rows.")


def load_input_rows(path: str) -> List[Mapping[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        body = json.load(fh)
    return rows_from_lxcloud_response(body)


def normalize_records(config: SourceConfig, rows: Iterable[Mapping[str, Any]]) -> List[ApprovalRecord]:
    records: List[ApprovalRecord] = []
    for row in rows:
        logic_id = field(row, "Flogic_id")
        if not logic_id:
            continue
        oper_type = field(row, "Foper_type", "0")
        summary = first_field(row, ("Fcontent", "Fapproval_detail", "Fbiz_info"))
        records.append(
            ApprovalRecord(
                scope=config.scope,
                source=config.source,
                logic_id=logic_id,
                approval_state=field(row, "Fapproval_state"),
                modify_time=field(row, "Fmodify_time"),
                oper_type=oper_type,
                plan_id=field(row, "Fplan_id"),
                package_id=first_field(row, ("Fplan_package_id", "Fpackage_id", "package_id", "packageId")),
                package_name=first_field(row, ("Fpackage_name", "package_name", "packageName")),
                publish_type=field(row, "Fpublish_type"),
                publish_mode=field(row, "Fpublish_mode"),
                applicant=first_field(row, ("Fapply_operator", "Foperator", "Fname", "operator")),
                approval_operator=field(row, "Fapproval_operator"),
                business_type=business_type_for(config.source, oper_type),
                summary=compact_text(summary),
                raw=row,
            )
        )
    return records


def collect_records(args: argparse.Namespace, pending: bool = True) -> List[ApprovalRecord]:
    configs = selected_source_configs(args.scope, args.source)
    logic_ids = split_logic_ids(args.logic_id)
    if args.input_json:
        if len(configs) != 1:
            raise UserError("--input-json requires --source hawk or --source process, not --source all.")
        rows = load_input_rows(args.input_json)
        records = normalize_records(configs[0], rows)
    else:
        records = []
        for config in configs:
            records.extend(normalize_records(config, query_lxcloud(args, config, pending=pending, logic_ids=logic_ids)))
    if logic_ids:
        wanted = set(logic_ids)
        records = [record for record in records if record.logic_id in wanted]
    package_ids = set(split_numeric_ids(args.package_id, "package id"))
    if package_ids:
        records = [record for record in records if record.package_id in package_ids]
    plan_ids = set(split_numeric_ids(args.plan_id, "plan id"))
    if plan_ids:
        records = [record for record in records if record.plan_id in plan_ids]
    return records


def route_for(record: ApprovalRecord) -> CallbackRoute:
    if record.source == "process":
        return ROUTES["process_engine"]
    if record.oper_type == "1":
        return ROUTES["hawk_process_publish"]
    return ROUTES["hawk_manage"]


def parse_target(value: str) -> Tuple[str, Target]:
    if "=" not in value:
        raise UserError(f"Invalid --target {value!r}; expected key=ip:port[:group[:version]].")
    key, raw = value.split("=", 1)
    parts = raw.split(":")
    if len(parts) < 2:
        raise UserError(f"Invalid target value {raw!r}; expected ip:port[:group[:version]].")
    group = parts[2] if len(parts) >= 3 and parts[2] else "stable"
    version = parts[3] if len(parts) >= 4 and parts[3] else "1.0.0"
    return key.strip(), Target(ip=parts[0].strip(), port=parts[1].strip(), group=group, version=version)


def build_target(value: Mapping[str, Any], label: str, target_file: Path) -> Target:
    if not value.get("ip") or not value.get("port"):
        raise UserError(f"Target {label!r} in {target_file} must contain ip and port.")
    return Target(
        ip=str(value["ip"]),
        port=str(value["port"]),
        group=str(value.get("group", "stable")),
        version=str(value.get("version", "1.0.0")),
    )


def load_targets(args: argparse.Namespace) -> Dict[str, Target]:
    targets: Dict[str, Target] = {}
    target_file = Path(args.target_file).expanduser()
    if target_file.exists():
        with open(target_file, "r", encoding="utf-8") as fh:
            raw_targets = json.load(fh)
        if not isinstance(raw_targets, Mapping):
            raise UserError(f"Target file {target_file} must contain a JSON object.")
        for key, value in raw_targets.items():
            if not isinstance(value, Mapping):
                raise UserError(f"Target {key!r} in {target_file} must be an object.")
            # A scope block nests one entry per route: {"mexico": {"hawk_manage": {...}}}.
            if str(key) in SCOPE_CHOICES:
                scope_key = resolve_scope(str(key))
                for route_key, route_value in value.items():
                    if not isinstance(route_value, Mapping):
                        raise UserError(f"Target {key}.{route_key!r} in {target_file} must be an object.")
                    targets[f"{scope_key}.{route_key}"] = build_target(route_value, f"{key}.{route_key}", target_file)
                continue
            targets[str(key)] = build_target(value, str(key), target_file)

    for item in args.target or []:
        key, target = parse_target(item)
        targets[key] = target
    return targets


def bianque_headers(args: argparse.Namespace) -> Dict[str, str]:
    cookie = resolve_credentials(args).cookie
    if not cookie:
        raise UserError(
            "No bianque cookie. Export BIANQUE_COOKIE, or drop --no-browser-session so the local "
            "browser session can provide it."
        )
    return {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded",
        "cookie": cookie,
        "origin": "https://stable-bianque.lexinfintech.com",
    }


def callback_outcome(response_text: str) -> Tuple[bool, str]:
    """Bianque answers HTTP 200 even when the Dubbo call fails, so the body decides."""
    try:
        body = json.loads(response_text)
    except ValueError:
        return False, "unparsable response"
    data = body.get("data") if isinstance(body, Mapping) else None
    if not isinstance(data, Mapping):
        return False, "no data in response"
    if data.get("errcode") not in (0, "0"):
        return False, f"errcode={data.get('errcode')}"
    result = data.get("result")
    if isinstance(result, Mapping) and result.get("result") not in (0, "0", None):
        return False, f"result={result.get('result')} {result.get('res_info', '')}".strip()
    return True, ""


def invoke_callback(args: argparse.Namespace, record: ApprovalRecord, route: CallbackRoute, target: Target) -> Tuple[bool, str]:
    params = [{"code": 60, "logic_id": record.logic_id}]
    data = {
        "env": args.bianque_env,
        "service": route.service,
        "ip": target.ip,
        "port": target.port,
        "group": target.group,
        "version": target.version,
        "method": "handler",
        "params": json.dumps(params, ensure_ascii=False),
        "comment": route.comment,
        "stringFlag": "false",
    }
    response = requests.post(args.bianque_url, headers=bianque_headers(args), data=data, timeout=args.timeout)
    response.raise_for_status()
    ok, reason = callback_outcome(response.text)
    return ok, response.text if ok else f"{reason}: {response.text}"


def format_record(record: ApprovalRecord, include_route: bool, index: Optional[int] = None) -> Dict[str, str]:
    row = {
        "no": str(index) if index is not None else "",
        "biz": record.business_type,
        "package_id": record.package_id,
        "package_name": record.package_name,
        "plan_id": record.plan_id,
        "applicant": record.applicant,
        "approval_operator": record.approval_operator,
        "scope": record.scope,
        "source": record.source,
        "logic_id": record.logic_id,
        "state": record.approval_state,
        "oper_type": record.oper_type,
        "publish_type": record.publish_type,
        "publish_mode": record.publish_mode,
        "modify_time": record.modify_time,
        "summary": record.summary,
    }
    if include_route:
        route = route_for(record)
        row["route"] = route.key
        row["target"] = route.target_key
    return row


def print_rows(rows: Sequence[Mapping[str, str]], output: str) -> None:
    if output == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        print("No records.")
        return
    columns = list(rows[0].keys())
    widths = {column: max(len(column), *(len(str(row.get(column, ""))) for row in rows)) for column in columns}
    print(" | ".join(column.ljust(widths[column]) for column in columns))
    print("-+-".join("-" * widths[column] for column in columns))
    for row in rows:
        print(" | ".join(str(row.get(column, "")).ljust(widths[column]) for column in columns))


def command_list(args: argparse.Namespace) -> int:
    records = collect_records(args, pending=True)
    print_rows([format_record(record, include_route=True, index=index) for index, record in enumerate(records, 1)], args.output)
    return 0


def select_records_interactively(records: Sequence[ApprovalRecord], output: str) -> List[ApprovalRecord]:
    if not records:
        return []
    if output == "json":
        raise UserError("--select is interactive and requires --output table.")
    print_rows([format_record(record, include_route=True, index=index) for index, record in enumerate(records, 1)], "table")
    try:
        raw = input("\n请输入要处理的序号，多个用逗号分隔，直接回车取消: ").strip()
    except EOFError as exc:
        raise UserError("Cannot read selection from stdin.") from exc
    if not raw:
        raise UserError("Selection cancelled.")
    indexes: List[int] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if not item.isdigit():
            raise UserError(f"Invalid selection {item!r}; use row numbers from the no column.")
        index = int(item)
        if index < 1 or index > len(records):
            raise UserError(f"Selection {index} is out of range 1..{len(records)}.")
        indexes.append(index)
    if not indexes:
        raise UserError("No valid selection.")
    return [records[index - 1] for index in list(dict.fromkeys(indexes))]


def validate_approve_safety(args: argparse.Namespace, records: Sequence[ApprovalRecord]) -> None:
    logic_ids = split_logic_ids(args.logic_id)
    if not records:
        raise UserError("No pending approval records matched the query.")
    narrowed = bool(logic_ids or args.package_id or args.plan_id)
    if args.confirm and not narrowed and not args.select and not args.allow_bulk:
        raise UserError(
            "Refusing bulk approval without --logic-id/--package-id/--plan-id. Pass --allow-bulk if this is intentional."
        )
    if args.confirm and len(records) > 1 and not args.allow_bulk:
        raise UserError("Refusing to approve multiple records without --allow-bulk.")
    if args.confirm and len(records) > args.max_approve:
        raise UserError(f"Refusing to approve {len(records)} records; --max-approve is {args.max_approve}.")


def command_approve(args: argparse.Namespace) -> int:
    records = collect_records(args, pending=True)
    if args.select:
        records = select_records_interactively(records, args.output)
    validate_approve_safety(args, records)
    plan_rows = [format_record(record, include_route=True, index=index) for index, record in enumerate(records, 1)]
    print_rows(plan_rows, args.output)

    if not args.confirm:
        print("\nDRY RUN: no callbacks sent. Re-run with approve --confirm to execute.")
        return 0

    targets = load_targets(args)
    results: List[Dict[str, str]] = []
    for record in records:
        route = route_for(record)
        # Each region runs its own manage app, so a scoped target wins over the bare route key.
        scoped_key = f"{resolve_scope(record.scope)}.{route.target_key}"
        target = targets.get(scoped_key) or targets.get(route.target_key)
        if not target:
            raise UserError(
                f"Missing target {scoped_key!r}. Pass --target {scoped_key}=ip:port "
                f"or configure {Path(args.target_file).expanduser()}."
            )
        try:
            ok, response_text = invoke_callback(args, record, route, target)
            results.append(
                {
                    "biz": record.business_type,
                    "package_id": record.package_id,
                    "package_name": record.package_name,
                    "plan_id": record.plan_id,
                    "logic_id": record.logic_id,
                    "route": route.key,
                    "status": "sent" if ok else "failed",
                    "response": response_text[:300],
                }
            )
        except Exception as exc:  # requests exceptions are actionable execution failures
            results.append(
                {
                    "biz": record.business_type,
                    "package_id": record.package_id,
                    "package_name": record.package_name,
                    "plan_id": record.plan_id,
                    "logic_id": record.logic_id,
                    "route": route.key,
                    "status": "failed",
                    "response": str(exc),
                }
            )
        if args.sleep_after > 0:
            time.sleep(args.sleep_after)

    print("\nCallback results:")
    print_rows(results, args.output)
    if any(row["status"] != "sent" for row in results):
        print(
            "\nSome callbacks failed. Provider addresses drift after redeploys: re-check the stable "
            "instance with query-app-instances, then pass --target <scope>.<route_key>=ip:port."
        )

    if not args.skip_verify:
        verify_after_callbacks(args, records)
    return 0 if all(row["status"] == "sent" for row in results) else 1


def verify_after_callbacks(args: argparse.Namespace, records: Sequence[ApprovalRecord]) -> None:
    if args.input_json and not offline_token_available(args):
        print("\nVerification skipped: --input-json was used and no lxcloud credential is available.")
        return

    print("\nVerification:")
    verify_rows: List[Dict[str, str]] = []
    by_source: Dict[Tuple[str, str], List[str]] = {}
    for record in records:
        by_source.setdefault((record.scope, record.source), []).append(record.logic_id)

    original_scope = args.scope
    original_source = args.source
    original_logic_id = args.logic_id
    original_all_dates = args.all_dates
    original_package_id = args.package_id
    original_plan_id = args.plan_id
    try:
        args.all_dates = True
        # Records are already pinned by logic_id here; re-filtering would drop rows whose join is empty.
        args.package_id = None
        args.plan_id = None
        for (scope, source), logic_ids in by_source.items():
            args.scope = scope
            args.source = source
            args.logic_id = logic_ids
            for record in collect_records(args, pending=False):
                status = "still_pending" if record.approval_state == "10" else "changed"
                row = format_record(record, include_route=False)
                row["verify"] = status
                verify_rows.append(row)
    finally:
        args.scope = original_scope
        args.source = original_source
        args.logic_id = original_logic_id
        args.all_dates = original_all_dates
        args.package_id = original_package_id
        args.plan_id = original_plan_id

    print_rows(verify_rows, args.output)


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scope", choices=SCOPE_CHOICES, default="domestic", help="approval region; 'overseas' is an alias of 'mexico'")
    parser.add_argument("--source", choices=["hawk", "process", "all"], default="hawk", help="approval source")
    parser.add_argument("--logic-id", action="append", help="logic id to query or approve; repeat or comma-separate")
    parser.add_argument("--package-id", action="append", help="filter by package id; repeat or comma-separate (hawk source only)")
    parser.add_argument("--plan-id", action="append", help="filter by publish plan id; repeat or comma-separate (hawk source only)")
    parser.add_argument("--all-dates", action="store_true", help="do not restrict pending queries to today")
    parser.add_argument("--limit", type=int, default=100, help="maximum rows per source query")
    parser.add_argument("--input-json", help="read rows from a saved lxcloud response instead of querying lxcloud")
    parser.add_argument("--output", choices=["table", "json"], default="table")
    parser.add_argument("--print-sql", action="store_true", help="print generated SQL to stderr")
    parser.add_argument("--lxcloud-url", default=DEFAULT_LXCLOUD_URL)
    parser.add_argument("--query-type", default="single")
    parser.add_argument("--query-role", default="masterbackup")
    parser.add_argument("--user-name", default=os.environ.get("LXCLOUD_USER_NAME"), help="OA account for lxcloud; defaults to the token subject")
    parser.add_argument("--session-file", default=DEFAULT_SESSION_FILE, help="get-browser-session snapshot used when credentials are not in the environment")
    parser.add_argument(
        "--no-browser-session",
        action="store_true",
        default=os.environ.get("LXCLOUD_DISABLE_BROWSER_SESSION") == "1",
        help="never read or refresh the browser session snapshot; require credentials in the environment",
    )
    parser.add_argument("--timeout", type=int, default=30)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Safe stable/test Hawk approval helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="list pending approvals")
    add_common_args(list_parser)
    list_parser.set_defaults(func=command_list)

    approve_parser = subparsers.add_parser("approve", help="dry-run or execute approval callbacks")
    add_common_args(approve_parser)
    approve_parser.add_argument("--confirm", action="store_true", help="send callbacks; omitted means dry-run only")
    approve_parser.add_argument("--allow-bulk", action="store_true", help="allow approving multiple records")
    approve_parser.add_argument("--max-approve", type=int, default=20, help="hard cap for one confirmed run")
    approve_parser.add_argument("--target-file", default=DEFAULT_TARGET_FILE)
    approve_parser.add_argument("--target", action="append", help="callback target as key=ip:port[:group[:version]]")
    approve_parser.add_argument("--select", action="store_true", help="select records by row number after listing them")
    approve_parser.add_argument("--bianque-url", default=DEFAULT_BIANQUE_URL)
    approve_parser.add_argument("--bianque-env", default="stable")
    approve_parser.add_argument("--sleep-after", type=float, default=0.0, help="seconds to sleep after each callback")
    approve_parser.add_argument("--skip-verify", action="store_true", help="skip post-callback status verification")
    approve_parser.set_defaults(func=command_approve)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except UserError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except requests.RequestException as exc:
        print(f"request error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
