#!/usr/bin/env python3
"""Query Mihawk field references.

The script is read-only. By default it writes results to stdout only; pass
--output-file explicitly to persist CSV or JSON output.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


DEFAULT_ENDPOINT = (
    "https://mihawk.oa.fenqile.com/"
    "rc_oa_gateway/hawk_decision/manage/query_rule_by_field_name.json"
)

NODE_COLUMNS = [
    "field_name",
    "package_id",
    "package_name",
    "node_id",
    "node_name",
    "operator",
]

RULE_COLUMNS = [
    "field_name",
    "package_id",
    "package_name",
    "node_id",
    "node_name",
    "is_common",
    "strategy_id",
    "strategy_name",
    "rule_id",
    "rule_name",
    "rule_content",
    "operator",
]


@dataclass(frozen=True)
class QueryConfig:
    endpoint: str
    cookie: str | None
    limit: int
    max_pages: int | None
    sleep_ms: int
    timeout: int
    mock_response_file: Path | None


def read_fields(values: list[str] | None, field_file: str | None) -> list[str]:
    fields: list[str] = []
    if values:
        fields.extend(values)
    if field_file:
        path = Path(field_file)
        fields.extend(path.read_text(encoding="utf-8").splitlines())

    normalized: list[str] = []
    seen: set[str] = set()
    for field in fields:
        field = field.strip()
        if not field or field.startswith("#"):
            continue
        if field in seen:
            continue
        seen.add(field)
        normalized.append(field)
    return normalized


def request_json(config: QueryConfig, field: str, page: int) -> dict[str, Any]:
    if config.mock_response_file:
        return json.loads(config.mock_response_file.read_text(encoding="utf-8"))

    if not config.cookie:
        raise RuntimeError(
            "Missing Mihawk cookie. Prefer browser_session/get-browser-session; "
            "for script fallback set MIHAWK_COOKIE in the local shell."
        )

    query = urllib.parse.urlencode(
        {"field_name": field, "page": str(page), "limit": str(config.limit)}
    )
    url = f"{config.endpoint}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/plain, */*",
            "Cookie": config.cookie,
            "Referer": "https://mihawk.oa.fenqile.com/index.html",
            "User-Agent": "hawk-field-ref-cli/1.0",
            "X-Requested-With": "XMLHttpRequest",
        },
        method="GET",
    )

    with urllib.request.urlopen(request, timeout=config.timeout) as response:
        body = response.read().decode("utf-8")
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Mihawk response is not JSON; login may have expired.") from exc


def get_nested_rule_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result_rows = payload.get("result_rows") or []
    if not isinstance(result_rows, list) or not result_rows:
        return []
    first_row = result_rows[0] or {}
    rule_list = first_row.get("rule_list") or []
    if not isinstance(rule_list, list):
        return []
    return [item for item in rule_list if isinstance(item, dict)]


def value(record: dict[str, Any], key: str) -> str:
    raw = record.get(key)
    if raw is None or raw == "null":
        return ""
    return str(raw)


def package_id_for(record: dict[str, Any]) -> str:
    return value(record, "package_id") or value(record, "level_id1")


def rule_content(record: dict[str, Any]) -> str:
    raw = value(record, "rule_data_str")
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    content = parsed.get("ruleContent")
    return str(content) if content else raw


def normalize_record(mode: str, field: str, record: dict[str, Any]) -> dict[str, str]:
    common = {
        "field_name": value(record, "field_name") or field,
        "package_id": package_id_for(record),
        "package_name": value(record, "package_name") or value(record, "level_name1"),
        "node_id": value(record, "node_id") or value(record, "level_id2"),
        "node_name": value(record, "node_name") or value(record, "level_name2"),
        "operator": value(record, "operator"),
    }
    if mode == "node":
        return common

    common.update(
        {
            "is_common": "是" if value(record, "is_common") == "1" else "否",
            "strategy_id": value(record, "strategy_id"),
            "strategy_name": value(record, "strategy_name"),
            "rule_id": value(record, "rule_id"),
            "rule_name": value(record, "name"),
            "rule_content": rule_content(record),
        }
    )
    return common


def dedupe_key(mode: str, row: dict[str, str]) -> tuple[str, ...]:
    if mode == "node":
        return (row["field_name"], row["package_id"], row["node_id"])
    return (
        row["field_name"],
        row["package_id"],
        row["node_id"],
        row["strategy_id"],
        row["rule_id"],
    )


def query_field(
    field: str,
    mode: str,
    config: QueryConfig,
    fetch: Callable[[QueryConfig, str, int], dict[str, Any]] = request_json,
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, ...]] = set()
    page = 1
    total_pages = sys.maxsize

    while page <= total_pages:
        if config.max_pages is not None and page > config.max_pages:
            break

        payload = fetch(config, field, page)
        if page == 1:
            total = payload.get("total_page")
            try:
                total_pages = int(total)
            except (TypeError, ValueError):
                total_pages = 1
            if total_pages < 1:
                break

        records = get_nested_rule_list(payload)
        if not records:
            break

        for record in records:
            if not package_id_for(record):
                continue
            row = normalize_record(mode, field, record)
            key = dedupe_key(mode, row)
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)

        page += 1
        if config.sleep_ms > 0 and page <= total_pages:
            time.sleep(config.sleep_ms / 1000)

    return rows


def render_table(rows: list[dict[str, str]], columns: list[str]) -> str:
    if not rows:
        return "No records."

    widths = {
        column: max(len(column), *(len(row.get(column, "")) for row in rows))
        for column in columns
    }
    header = "  ".join(column.ljust(widths[column]) for column in columns)
    line = "  ".join("-" * widths[column] for column in columns)
    body = [
        "  ".join(row.get(column, "").ljust(widths[column]) for column in columns)
        for row in rows
    ]
    return "\n".join([header, line, *body])


def render_csv(rows: list[dict[str, str]], columns: list[str]) -> str:
    from io import StringIO

    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return output.getvalue()


def render_output(rows: list[dict[str, str]], columns: list[str], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(rows, ensure_ascii=False, indent=2)
    if fmt == "csv":
        return render_csv(rows, columns)
    return render_table(rows, columns)


def write_or_print(content: str, output_file: str | None) -> None:
    if output_file:
        Path(output_file).write_text(content, encoding="utf-8")
        print(f"Wrote result to {output_file}", file=sys.stderr)
        return
    print(content)


def run_query(args: argparse.Namespace) -> int:
    fields = read_fields(args.field, args.field_file)
    if not fields:
        print("No field names provided. Use --field or --field-file.", file=sys.stderr)
        return 2

    cookie = os.environ.get(args.cookie_env)
    mock_response_file = Path(args.mock_response_file) if args.mock_response_file else None
    config = QueryConfig(
        endpoint=args.endpoint,
        cookie=cookie,
        limit=args.limit,
        max_pages=args.max_pages,
        sleep_ms=args.sleep_ms,
        timeout=args.timeout,
        mock_response_file=mock_response_file,
    )

    all_rows: list[dict[str, str]] = []
    for index, field in enumerate(fields, start=1):
        rows = query_field(field, args.mode, config)
        print(
            f"[{index}/{len(fields)}] field={field} ref_count={len(rows)}",
            file=sys.stderr,
        )
        all_rows.extend(rows)

    columns = NODE_COLUMNS if args.mode == "node" else RULE_COLUMNS
    content = render_output(all_rows, columns, args.format)
    write_or_print(content, args.output_file)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    query = subparsers.add_parser("query", help="query field references")
    query.add_argument("--field", action="append", help="field name, repeatable")
    query.add_argument("--field-file", help="file containing one field name per line")
    query.add_argument("--mode", choices=["node", "rule"], default="node")
    query.add_argument("--format", choices=["table", "json", "csv"], default="table")
    query.add_argument("--output-file", help="write result only when explicitly set")
    query.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    query.add_argument("--limit", type=int, default=1000)
    query.add_argument("--max-pages", type=int)
    query.add_argument("--sleep-ms", type=int, default=80)
    query.add_argument("--timeout", type=int, default=15)
    query.add_argument("--cookie-env", default="MIHAWK_COOKIE")
    query.add_argument(
        "--mock-response-file",
        help="offline validation helper: reuse one Mihawk JSON response file",
    )
    query.set_defaults(func=run_query)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
