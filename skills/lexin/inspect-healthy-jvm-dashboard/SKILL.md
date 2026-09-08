---
name: inspect-healthy-jvm-dashboard
description: "Use when 需要只读查看、理解或对比 Healthy/雷神 JVM、JVM 内存、G1 GC 监控看板，例如 https://healthy.lexincloud.com/show/dashboard/11147 或 /dashboards/14333；自动复用浏览器登录态，回读大盘配置，整理变量、面板、PromQL、页面快照、明显配置问题，并可按 app/env 拉取实例级 JVM 指标摘要。"
metadata:
  version: 1.1.1
---

# inspect-healthy-jvm-dashboard

## 定位

只读查看 Healthy/雷神 JVM/G1 监控看板，帮助快速回答“这个看板看什么、怎么筛选、有哪些面板、PromQL 是什么、当前某个 app/env 的 JVM 内存和 GC 状态怎么样、和另一个 JVM 看板有什么差异”。

不负责修改大盘配置；需要新增变量、改面板或写入 configs 时，转用 `healthy-dashboard-config`。

## 工具优先级

MCP 优先、脚本兜底：

1. 先用 `browser_session.ensure_session` 复用或刷新 Healthy 登录态，默认 profile 是 `/home/joney/.local/state/agent-tools/browser-profiles/healthy`。
2. 用 `healthy.healthy_read_board` 只读回读大盘配置，确认 `/tmp/healthy-dashboard-{boardId}-after.json` 已生成。
3. 用本 skill 脚本汇总变量、分区、面板、PromQL 和页面快照。
4. 如果用户指定应用或当前仓库能识别 `application.name`，传 `--app` 和 `--env` 拉取 Prometheus 只读指标摘要；默认 `--env=prod`、`--range=1h`。

不要让用户在聊天里提供 Cookie、token、验证码或密码。

## 默认看板

常用 JVM 看板：

- `11147`: `https://healthy.lexincloud.com/show/dashboard/11147`，名称是 `火眼JVM G1垃圾回收器`，聚焦 JVM 基础指标与 G1 GC。
- `14333`: `https://healthy.lexincloud.com/dashboards/14333`，名称是 `executor节点大盘`，包含 JVM、G1、机器监控和 executor 决策调用指标。

用户只说“这个 JVM/G1 看板”且上下文没有其他 URL 时，默认使用 `11147`。

## 推荐流程

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js \
  --board=11147 \
  --url=https://healthy.lexincloud.com/show/dashboard/11147 \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy
```

如果已经有回读备份，只想离线摘要：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js \
  --from=/tmp/healthy-dashboard-11147-after.json \
  --no-page
```

查看某个应用在指定环境的 JVM 指标摘要：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js \
  --board=11147 \
  --url=https://healthy.lexincloud.com/show/dashboard/11147 \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --app=server_af_field_computing_java \
  --env=prod \
  --range=1h \
  --no-page
```

聚焦某一台实例：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js \
  --board=11147 \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --app=server_af_field_computing_java \
  --env=prod \
  --ident=10.27.67.10 \
  --range=6h \
  --no-page
```

输出时优先说明：

- 看板 id、名称、标签、面板数量。
- 变量定义，特别是 `app/env/ident` 的 label source。
- 分区和核心指标：老年代、Eden、新生代晋升、GC 吞吐、线程、G1 young/old GC。
- 应用巡检结果：实例数和 set 分布、采样时间、老年代/eden 使用率和使用量、晋升量、GC 吞吐、线程、G1 young/old GC 次数与耗时、当前 Top 实例和区间峰值 Top 实例。
- PromQL 中是否缺少 `env="$env"`、是否存在重复面板名、是否有明显的空 ident 过滤差异。
- 页面当前默认参数和哪些区域显示 `暂无数据`。

## 判断要点

- `11147` 的变量 `env/ident` 基于 `old_gen_mem_ratio`，面板主要是 `old_gen_mem_*`、`eden_gen_mem_*`、`thread_*`、`g1_*`。
- `14333` 的变量 `env/ident` 基于 `old_gen_mem_used`，除了 JVM/G1，还包含机器指标和业务决策指标。
- `11147` 的面板 PromQL 多数没有直接带 `env="$env"`，只通过 `ident` 变量间接隔离环境；按应用巡检时必须在查询表达式显式加入 `env="<env>"`，避免跨环境混入。
- `eden_gen_mem_ratio` 在部分应用上可能长期为 `0`，此时以 `eden_gen_mem_used` 和 Young GC 指标辅助判断。
- 页面 URL 可能是 `/show/dashboard/{id}` 或 `/dashboards/{id}`；回读 API 都按 board id 调用。
- 只读查看时不要调用 `PUT /api/n9e/board/{id}/configs`。
