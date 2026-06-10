"""Read-only Java application host diagnostics MCP server."""

from __future__ import annotations

import re

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import bounded_int, error_text
from java_backend_mcp.java_app_diag_core import (
    BastionDiagSession,
    app_log_dir,
    app_log_path,
    ensure_success,
    q,
    validate_app,
    validate_health_path,
    validate_keyword,
    validate_log_file,
    validate_pid,
    validate_port,
    validate_version,
    version_log_dir,
    version_log_path,
)

mcp = FastMCP("Java App Diagnostics")
session = BastionDiagSession()


async def _execute(ip: str, command: str, timeout: int = 30) -> str:
    return await session.execute(ip, command, bounded_int(timeout, 30, 5, 180))


async def _resolve_pid(ip: str, app_name: str = "", pid: str = "", timeout: int = 30) -> str:
    if pid:
        return validate_pid(pid)
    if not app_name:
        raise ValueError("pid or app_name is required")
    app = validate_app(app_name)
    command = ensure_success(
        f"ps -eo pid,args | grep -F -- {q(app)} | grep -F java | grep -v grep | head -1"
    )
    output = await _execute(ip, command, timeout)
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped == "__java_app_diag_done__":
            continue
        match = re.match(r"^([1-9][0-9]*)\s+", stripped)
        if match:
            return validate_pid(match.group(1))
    raise RuntimeError(f"java process not found for app_name={app_name}: {output[:1000]}")


@mcp.tool()
async def connect_app_server_bastion(password: str = "", otp: str = "", keepalive_ip: str = "") -> str:
    """连接堡垒机，供 Java 应用服务器只读诊断使用。PEM 认证足够时可不传密码。"""
    return await session.connect(password=password, otp=otp, keepalive_ip=keepalive_ip)


@mcp.tool()
async def app_server_connection_status() -> str:
    """查看 Java 应用诊断 MCP 的堡垒机连接状态。"""
    return await session.status()


@mcp.tool()
async def server_basic_status(ip: str, timeout: int = 30) -> str:
    """查看服务器基础状态：时间、主机名、负载、内存、磁盘和 vmstat。"""
    command = ensure_success(
        "echo '== date ==' ; date ; "
        "echo '== hostname ==' ; hostname ; "
        "echo '== uptime ==' ; uptime ; "
        "echo '== memory_mb ==' ; free -m ; "
        "echo '== disk ==' ; df -h / /home /home/product ; "
        "echo '== vmstat ==' ; vmstat 1 3"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def discover_java_apps(ip: str, timeout: int = 30) -> str:
    """从目标机标准路径和 Java 进程中发现候选应用名。用于已知 IP、未给 app_name 的场景。"""
    command = ensure_success(
        "echo '== shared_log_apps ==' ; "
        "find /home/product/logs -maxdepth 1 -type d -name '*_logs' | "
        "awk -F/ '{name=$NF; sub(/_logs$/, \"\", name); print name}' | sort | uniq | head -100 ; "
        "echo '== publish_apps ==' ; "
        "find /home/publish_product/server_java -maxdepth 1 -type d | "
        "awk -F/ '{print $NF}' | grep -v '^server_java$' | sort | uniq | head -100 ; "
        "echo '== java_processes ==' ; "
        "ps -eo pid,etime,pcpu,pmem,args | grep -F java | grep -v grep | head -50"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def find_java_process(ip: str, app_name: str, timeout: int = 30) -> str:
    """按应用名查 Java 进程，返回 PID、启动时间、CPU、内存、线程数和启动命令摘要。"""
    try:
        app = validate_app(app_name)
    except ValueError as exc:
        return error_text(str(exc))
    command = ensure_success(
        f"ps -eo pid,ppid,lstart,etime,pcpu,pmem,rss,vsz,nlwp,args | "
        f"grep -F -- {q(app)} | grep -F java | grep -v grep | head -20"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def java_process_status(ip: str, app_name: str = "", pid: str = "", timeout: int = 30) -> str:
    """查看 Java 进程资源状态。可传 pid，或传 app_name 自动取首个匹配 Java 进程。"""
    try:
        target_pid = await _resolve_pid(ip, app_name=app_name, pid=pid, timeout=timeout)
    except (RuntimeError, ValueError) as exc:
        return error_text(str(exc))
    command = ensure_success(
        f"echo '== ps ==' ; ps -p {target_pid} -o pid,ppid,lstart,etime,pcpu,pmem,rss,vsz,nlwp,args ; "
        f"echo '== proc_status ==' ; grep -E '^(Name|State|Pid|PPid|Threads|VmRSS|VmSize|VmPeak|FDSize|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' /proc/{target_pid}/status ; "
        f"echo '== limits ==' ; cat /proc/{target_pid}/limits ; "
        f"echo '== fd_count ==' ; ls /proc/{target_pid}/fd | wc -l"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def network_port_status(ip: str, port: str = "", timeout: int = 30) -> str:
    """查看监听端口和 TCP 状态分布；传 port 时聚焦该端口连接。"""
    state_awk = q("NR>1 {count[$1]++} END {for (s in count) print s, count[s]}")
    if port:
        try:
            target_port = validate_port(port)
        except ValueError as exc:
            return error_text(str(exc))
        pattern = q(f":{target_port}([[:space:]]|$)")
        command = ensure_success(
            f"echo '== listen:{target_port} ==' ; ss -lntp | grep -E {pattern} ; "
            f"echo '== connections:{target_port} ==' ; ss -antp | grep -E {pattern} | head -120 ; "
            f"echo '== tcp_states ==' ; ss -ant | awk {state_awk}"
        )
    else:
        command = ensure_success(
            f"echo '== listen ==' ; ss -lntp | head -120 ; "
            f"echo '== tcp_states ==' ; ss -ant | awk {state_awk}"
        )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def java_jvm_summary(ip: str, app_name: str = "", pid: str = "", timeout: int = 60) -> str:
    """查看 JVM 轻量信息：VM.version、VM.flags 和 jstat GC 概览。"""
    try:
        target_pid = await _resolve_pid(ip, app_name=app_name, pid=pid, timeout=timeout)
    except (RuntimeError, ValueError) as exc:
        return error_text(str(exc))
    command = ensure_success(
        f"echo '== jcmd VM.version ==' ; jcmd {target_pid} VM.version ; "
        f"echo '== jcmd VM.flags ==' ; jcmd {target_pid} VM.flags ; "
        f"echo '== jstat gcutil ==' ; jstat -gcutil {target_pid} 1000 3"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def java_thread_summary(ip: str, app_name: str = "", pid: str = "", keyword: str = "", lines: int = 200, timeout: int = 60) -> str:
    """查看 Java 线程摘要。默认过滤线程名、线程状态和 deadlock 线索；keyword 可进一步过滤。"""
    try:
        target_pid = await _resolve_pid(ip, app_name=app_name, pid=pid, timeout=timeout)
        line_count = bounded_int(lines, 200, 20, 1000)
        if keyword:
            grep = f"grep -i -- {q(validate_keyword(keyword))}"
        else:
            grep = "egrep 'nid=|java.lang.Thread.State|BLOCKED|WAITING|TIMED_WAITING|RUNNABLE|deadlock|Deadlock'"
    except (RuntimeError, ValueError) as exc:
        return error_text(str(exc))
    command = ensure_success(
        f"echo '== thread_summary pid={target_pid} ==' ; "
        f"jcmd {target_pid} Thread.print | {grep} | head -{line_count}"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def java_gc_log_summary(ip: str, app_name: str, timeout: int = 30) -> str:
    """汇总共享日志目录中的 GC/OOM 线索和 GC 日志文件。"""
    try:
        log_dir = app_log_dir(app_name)
    except ValueError as exc:
        return error_text(str(exc))
    gc_pattern = q("Full GC|OutOfMemoryError|GC overhead|Metaspace|java.lang.OutOfMemoryError")
    command = ensure_success(
        f"echo '== gc_files ==' ; find {q(log_dir)} -maxdepth 1 -type f | grep -i 'gc.*log' | head -20 ; "
        f"echo '== oom_in_error_log ==' ; grep -E -i {gc_pattern} {q(log_dir)}/error.log | tail -80 ; "
        f"echo '== gc_keywords ==' ; grep -E -i {gc_pattern} {q(log_dir)}/*gc*.log* | tail -80"
    )
    return await _execute(ip, command, timeout)


@mcp.tool()
async def local_health_get(ip: str, port: str, path: str = "/actuator/health", timeout: int = 15, max_chars: int = 12000) -> str:
    """在目标机本机回环地址上执行只读 HTTP GET，默认查询 /actuator/health。"""
    try:
        target_port = validate_port(port)
        safe_path = validate_health_path(path)
    except ValueError as exc:
        return error_text(str(exc))
    limit = bounded_int(max_chars, 12000, 100, 50000)
    curl_timeout = bounded_int(timeout, 15, 2, 60)
    command = ensure_success(
        f"curl -sS --max-time {curl_timeout} {q(f'http://127.0.0.1:{target_port}{safe_path}')} | head -c {limit}"
    )
    return await _execute(ip, command, curl_timeout + 10)


@mcp.tool()
async def list_log_files(ip: str, app_name: str, timeout: int = 30) -> str:
    """列出 /home/product/logs/{app_name}_logs/ 下的共享应用日志文件。"""
    try:
        command = f"ls {q(app_log_dir(app_name))}/"
    except ValueError as exc:
        return error_text(str(exc))
    return await _execute(ip, command, timeout)


@mcp.tool()
async def tail_app_log(ip: str, app_name: str, file_name: str = "error.log", lines: int = 200, timeout: int = 30) -> str:
    """查看共享应用日志尾部内容。支持 debug/error/info/stdout 日志及其轮转文件。"""
    try:
        path = app_log_path(app_name, file_name)
        line_count = bounded_int(lines, 200, 1, 1000)
    except ValueError as exc:
        return error_text(str(exc))
    reader = f"zcat {q(path)}" if path.endswith(".gz") else f"tail -{line_count} {q(path)}"
    command = reader if path.endswith(".gz") else reader
    if path.endswith(".gz"):
        command = f"{reader} | tail -{line_count}"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def grep_app_log(
    ip: str,
    app_name: str,
    keyword: str,
    file_name: str = "error.log",
    ignore_case: bool = True,
    lines: int = 50,
    timeout: int = 30,
) -> str:
    """按关键字查询共享应用日志。仅执行只读 grep/zcat/tail。"""
    try:
        path = app_log_path(app_name, file_name)
        safe_keyword = validate_keyword(keyword)
        line_count = bounded_int(lines, 50, 1, 500)
    except ValueError as exc:
        return error_text(str(exc))
    grep_flag = "-i " if ignore_case else ""
    if path.endswith(".gz"):
        command = f"zcat {q(path)} | grep {grep_flag}{q(safe_keyword)} | tail -{line_count}"
    else:
        command = f"grep {grep_flag}{q(safe_keyword)} {q(path)} | tail -{line_count}"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def recent_error_summary(ip: str, app_name: str, timeout: int = 30) -> str:
    """提取共享 error.log 里最近的 ERROR/Exception/Caused by 关键行。"""
    try:
        path = app_log_path(app_name, "error.log")
    except ValueError as exc:
        return error_text(str(exc))
    command = f"grep -i 'ERROR\\|Exception\\|Throwable\\|Caused by' {q(path)} | tail -80"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def list_version_log_files(ip: str, app_name: str, version_tag: str, timeout: int = 30) -> str:
    """列出 /home/publish_product/server_java/{app_name}/{version_tag}/logs/ 下的版本本地日志。"""
    try:
        validate_version(version_tag)
        command = f"ls {q(version_log_dir(app_name, version_tag))}/"
    except ValueError as exc:
        return error_text(str(exc))
    return await _execute(ip, command, timeout)


@mcp.tool()
async def tail_version_log(ip: str, app_name: str, version_tag: str, file_name: str = "stdout.log", lines: int = 240, timeout: int = 30) -> str:
    """查看版本本地日志尾部内容，常用于发布后启动诊断。"""
    try:
        path = version_log_path(app_name, version_tag, validate_log_file(file_name, "stdout.log"))
        line_count = bounded_int(lines, 240, 1, 1500)
    except ValueError as exc:
        return error_text(str(exc))
    if path.endswith(".gz"):
        command = f"zcat {q(path)} | tail -{line_count}"
    else:
        command = f"tail -{line_count} {q(path)}"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def grep_version_log(
    ip: str,
    app_name: str,
    version_tag: str,
    keyword: str,
    file_name: str = "stdout.log",
    ignore_case: bool = True,
    lines: int = 120,
    timeout: int = 30,
) -> str:
    """按关键字查询版本本地日志，常用于发布后启动诊断。"""
    try:
        path = version_log_path(app_name, version_tag, validate_log_file(file_name, "stdout.log"))
        safe_keyword = validate_keyword(keyword)
        line_count = bounded_int(lines, 120, 1, 500)
    except ValueError as exc:
        return error_text(str(exc))
    grep_flag = "-i " if ignore_case else ""
    if path.endswith(".gz"):
        command = f"zcat {q(path)} | grep {grep_flag}{q(safe_keyword)} | tail -{line_count}"
    else:
        command = f"grep {grep_flag}{q(safe_keyword)} {q(path)} | tail -{line_count}"
    return await _execute(ip, command, timeout)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
