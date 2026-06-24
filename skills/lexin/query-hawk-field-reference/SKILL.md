---
name: query-hawk-field-reference
description: 查询米霍克字段引用关系。Use when 用户要求查询字段被哪些乐包、策略节点、执行节点或规则引用，梳理 Hawk 字段影响面，从 /home/joney/tools/hawk/HawkFieldRefUtil.java 旧脚本迁移字段引用查询流程，或要求结果默认只输出到终端、不落结果文件。
version: 1.0.0
---

# query-hawk-field-reference

## 定位

只读查询米霍克字段引用关系，把字段名映射到引用它的乐包、策略节点和规则。它不修改米霍克配置、不发布乐包、不审批、不调用写接口。

MCP 优先、脚本兜底。优先复用 `browser_session` MCP 或 `get-browser-session` skill 的登录态访问 `https://mihawk.oa.fenqile.com/`；MCP 不可用时，使用脚本 `/home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py`，并从环境变量读取临时 Cookie。

## 安全边界

- 只调用米霍克只读接口 `GET /rc_oa_gateway/hawk_decision/manage/query_rule_by_field_name.json`。
- 不在 skill、脚本、日志或最终回复中保存、回显 Cookie、token、ticket 或登录态明文。
- 用户贴出 Cookie 时，不复用到文件；如确需脚本兜底，让用户在本地 shell 设置 `MIHAWK_COOKIE`。
- 默认只输出到终端。只有用户显式指定 `--output-file` 时才写 CSV/JSON 文件。
- 字段名必须 URL encode 后请求，不拼接裸字符串。

## 查询流程

1. 确认输入字段：优先使用用户给出的字段列表；字段较多时使用 `--field-file`，一行一个字段。
2. 确认查询视角：
   - `node`：默认模式，只看字段关联到哪些乐包和策略节点。
   - `rule`：需要规则明细、执行节点、规则内容时使用。
3. 优先用浏览器登录态或 MCP 发起只读请求；需要批量、分页、去重、CSV/JSON stdout 时用脚本。
4. 输出结果时保留业务字段：`package_id`、`package_name`、`node_id`、`node_name`，rule 模式再输出规则字段。
5. 如果接口返回空，说明没有查到当前字段的米霍克引用或登录态失效；先区分 401/跳登录与真实空结果。

## 脚本用法

默认只输出终端：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --field user_age
```

批量字段：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --field-file /tmp/fields.txt
```

规则明细：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --mode rule --field user_age --format table
```

输出 JSON 到终端：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --field user_age --format json
```

只有显式指定时才落文件：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --field-file /tmp/fields.txt --format csv --output-file /tmp/hawk-field-ref.csv
```

MCP 不可用、需要脚本直接请求时：

```bash
export MIHAWK_COOKIE=<临时Cookie>
python3 /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py query --field user_age
```

## 输出字段

`node` 模式：

```text
field_name, package_id, package_name, node_id, node_name, operator
```

`rule` 模式：

```text
field_name, package_id, package_name, node_id, node_name, is_common, strategy_id, strategy_name, rule_id, rule_name, rule_content, operator
```

去重规则：

- `node`：按 `field_name + package_id + node_id` 去重。
- `rule`：按 `field_name + package_id + node_id + strategy_id + rule_id` 去重。

## 旧脚本迁移口径

旧 Java 脚本在 `/home/joney/tools/hawk/HawkFieldRefUtil.java`，核心口径保留：

- 接口路径：`/rc_oa_gateway/hawk_decision/manage/query_rule_by_field_name.json`
- 分页参数：`field_name`、`page`、`limit`
- 只保留 `package_id` 非空的记录
- `rule_data_str.ruleContent` 存在时输出 `ruleContent`，否则输出原始 `rule_data_str`
- `is_common=1` 输出“是”，其他输出“否”

迁移后修正：

- 不硬编码 Cookie。
- 不硬编码 Windows 输入/输出路径。
- 默认不写 CSV 文件。
- 字段名 URL encode。
- 使用真实 sleep 做限流。
