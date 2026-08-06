# shellcheck shell=bash
# 公共凭证加载逻辑，由 bin/ 下的包装脚本 source 使用。
#
# 关键行为：**只导出有值的变量**。模板里大量键是留空的占位，若把空值也导出，
# Python 的 os.environ.get("X", default) 会拿到 "" 而不是 default，反而覆盖掉
# 各 skill 自己的默认值。所以空值一律跳过。

agent_tools_env_file() {
    local repo_dir="$1"
    echo "${AGENT_TOOLS_ENV_FILE:-$repo_dir/env/credentials.env}"
}

# load_agent_tools_env <repo_dir> [--required]
# --required 时，凭证文件缺失直接报错退出；否则缺失只是静默跳过。
load_agent_tools_env() {
    local repo_dir="$1"
    local required="${2:-}"
    local env_file
    env_file="$(agent_tools_env_file "$repo_dir")"

    if [[ ! -f "$env_file" ]]; then
        if [[ "$required" == "--required" ]]; then
            echo "缺少凭证文件：$env_file" >&2
            echo "请执行：cp $repo_dir/env/credentials.env.example $env_file && chmod 600 $env_file" >&2
            return 1
        fi
        return 0
    fi

    local perm
    perm="$(stat -c '%a' "$env_file" 2>/dev/null || echo '')"
    if [[ -n "$perm" && "$perm" != "600" && "$perm" != "400" ]]; then
        echo "提示：$env_file 权限为 $perm，建议 chmod 600" >&2
    fi

    local line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        [[ "$line" != *"="* ]] && continue

        key="${line%%=*}"
        value="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        # 去掉成对引号
        if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
            value="${value:1:${#value}-2}"
        fi

        [[ -z "$value" ]] && continue                       # 空值跳过，见上方说明
        [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue
        export "$key=$value"
    done < "$env_file"
}
