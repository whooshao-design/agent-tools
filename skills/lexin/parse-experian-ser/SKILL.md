---
name: parse-experian-ser
description: 只读拉取并解析旧规则引擎的 Experian Strategy Manager SER 规则包（解密后的 .ser，Java 序列化 ExecutableStrategy），输出可读的决策流程、拒绝规则、衍生变量脚本和输入输出字段。Use when 用户要求查看某个 SER 包（如 FQLDHTE、BE）里的规则内容、决策点分支、阈值或原因码，核对旧 SER 规则逻辑，或为 SER 迁移米霍克做规则对照；不用于米霍克规则或 SER 部署发布。
metadata:
  version: 1.2.0
---

# parse-experian-ser

## 定位

- 治理：从 `decision_agent_server_java` 机器只读拉取解密后的 `.ser`，在本地反序列化并渲染为可读规则文本。
- 不治理：SER 上传、部署、灰度（归 `server_credit_ser_deploy_java` 与 OA 页面）；米霍克规则查询（用 `query-hawk-field-reference` 等）；SER 原始设计工程（不在公司系统内，无法从这里获得）。
- 拉取文件走 bastion MCP 的 `execute_command`（MCP 优先）；本 skill 的脚本只负责本地组装、校验和渲染。

## 背景

- 运行链路：`server_rcrule_dispatcher_java → server_rcrule_engine_java → decision_agent_server_java`。后者从 FastDFS 下载加密包，解密后缓存在
  `/home/publish_product/server_java/decision_agent_server_java/decision_ser_file/salve_decision_agent_server_ser_<场景小写>/<md5>_<场景>.ser`
  （`salve` 是源码原文拼写）。同目录可能有几十个历史版本，按修改时间取最新，或按部署表的版本对应。
- 解密后的文件就是 Java 原生序列化的 `com.experian.stratman.decisionagent.business.ExecutableStrategy`，不需要再解密。
- 依赖 jar：`com.experian:da/das/resource:1.0.0`（`server_credit_ser_deploy_java-service/pom.xml`），需已在 `~/.m2`；缺失时先对该项目跑一次 `mvn dependency:resolve`。需要 JDK 8。
- 项目里现成的字段级解析在 `server_credit_ser_deploy_java` 的 `SerDefinitionInfoParser`，只取输入/输出字段和原因码；要看规则逻辑用本 skill 的 `SerPretty`。

## 流程

1. **定位实例和文件**：用 `query-app-instances` 查 `decision_agent_server_java` 的目标环境实例；生产需要用户明确授权只读访问。`connect_bastion` 后：
   ```bash
   ls -lt /home/publish_product/server_java/decision_agent_server_java/decision_ser_file/salve_decision_agent_server_ser_<scene>/ | head
   stat -c %s FILE && md5sum FILE
   ```
   记下字节数和 md5。文件名前缀是部署表 `Fmd5`（加密原包的 md5），不等于解密后文件的 `md5sum`，校验以 `md5sum` 结果为准。`connect_bastion` 提示需要 password/OTP，或反复报 `Error reading SSH protocol banner` 时，停下向用户要凭据或请其排查连接，不要换通道绕过。
2. **分块拉取**：每块 120000 字节，偏移从 1 开始，按块执行（命令必须包含完整文件路径，组装脚本靠它和 `tail -c +N` 识别）：
   ```bash
   tail -c +1 FILE | head -c 120000 | base64
   tail -c +120001 FILE | head -c 120000 | base64
   ```
   只用只读命令；不得在服务器上写、删、移动文件或重定向输出。
3. **组装与校验**（Claude Code 会话；transcript 在 `~/.claude/projects/<目录名>/<会话ID>.jsonl`，子 agent 的在同目录 `<会话ID>/subagents/` 下）：
   ```bash
   python3 -I /home/joney/projects/ai/agent-tools/skills/lexin/parse-experian-ser/scripts/assemble_b64_chunks.py \
     --transcript SESSION.jsonl --remote-path FILE --out WORKDIR/X.ser --size BYTES --md5 HEX
   ```
   结果过大被客户端存进 `tool-results/` 文件时，脚本会按 transcript 里的 "saved to" 路径读取原文。size 或 md5 不一致时不要继续解析，重拉缺失或出错的块。
4. **渲染**：
   ```bash
   /home/joney/projects/ai/agent-tools/skills/lexin/parse-experian-ser/scripts/ser_render.sh WORKDIR/X.ser pretty > X.pretty.txt
   ```
   `dump` 模式输出完整对象树，用于 `pretty` 未覆盖的节点类型。`xml` 模式（spike，仅以 FQLBYJ 验证过）把 .ser 还原成米霍克迁移工具 `SerXmlElement` 可读的 XML，未覆盖的节点类型在 stderr 打 `WARN` 并在 XML 中留 `UNSUPPORTED` 标记；原脚本注释、画布布局、`obj_info` 无法恢复。反序列化报 `serialVersionUID` 不匹配或流损坏，说明文件不完整或 jar 版本不对。
5. **解读与交付**：按决策点（`decision_scene`）找目标分支，整理衍生变量、拒绝规则集、额度/决策树和最终输出字段；每条结论注明来自哪个节点（如 `P149`），由结构推断的引擎语义标"推断"。

## 读输出

- 顶部是包属性和输入/输出字段字典（字段码 → 中文名），下面是按缩进展开的流程：`[Segmented]` 分段、`[衍生数据]` 脚本、规则集、决策树、矩阵、评分卡。
- 脚本是 SM 规则语言（`IF ... THEN ... ELSE IF ... END IF`，`:=` 赋值）。`FN1`、`FN2` 等是包内自定义函数，编号按包生成、含义因包而异（FQLDHTE 中 FN1 统计子串次数，FQLBYJ 中 FN1 取最小值），以输出末尾的"用户脚本函数"定义为准。
- 规则集的 `true_/false_` 两支若指向同一组类别，表示类别依次全部评估；这是结构推断，引擎语义未核实。

## 边界

- 文件内容是生产业务规则：原始 `.ser` 副本只放会话临时目录，用完删除；渲染结果默认也放临时目录，用户指定落盘位置时按用户指定，但不提交进 Git 仓库、不上传外部服务。
- 会话 transcript 和客户端保存的 `tool-results/` 文件里会留有 base64 原文；组装校验通过后删除对应的 `tool-results/mcp-bastion-execute_command-*.txt`，或交付时提醒用户清理。
- Codex 会话的 transcript 格式不同，组装脚本暂只支持 Claude Code。
