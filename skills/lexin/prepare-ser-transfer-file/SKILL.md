---
name: prepare-ser-transfer-file
description: 为米霍克 SER 迁移接口 TransferService#transfer 准备 filePath：从 decision_agent_server_java 服务器取解密后的 .ser，转成迁移工具读取的 XML，再上传到对应环境的 oss-fk 文件服务拿到 FastDFS 路径；区分线下 stable 与线上（预发布、灰度、prod 共用一套服务器和文件服务）。Use when 用户要迁移某个 SER 包（appId）到米霍克但手上没有 SER 包或迁移 XML、需要去服务器上找 SER 包、要在 stable 或预发布/线上调用 TransferService#transfer 而缺 filePath、或要把本地迁移 XML 上传到 oss-fk；只解析规则内容用 parse-experian-ser，不负责调用迁移接口本身。
metadata:
  version: 1.1.0
---

# prepare-ser-transfer-file

## 定位

- 治理：产出 `TransferService#transfer` 入参里的 `filePath`。链路是“服务器上解密后的 `.ser` → `SerToXml` 生成 XML → 上传 oss-fk（`scenes=fe_hawkdecision`）→ 返回 `/fehawkdecision.../M00/ex/<时间戳>-<uuid>.txt`”。
- 不治理：SER 规则解读（`parse-experian-ser`）；迁移接口调用与结果核对（`test-dubbo-api` / devtools `dubbo_call`，调用前必须得到用户授权，线上库写入尤其如此）；Hippo 迁移配置（`configure-hippo`）。
- 拉文件走 bastion MCP（MCP 优先），转换复用 `parse-experian-ser` 的脚本，上传用本 skill 的脚本。

## 环境对照

| | 线下（stable/项目环境） | 线上（预发布、灰度、prod 共用） |
|---|---|---|
| SER 所在服务器 | stable 的 `decision_agent_server_java` 实例（2026-11-11 只有 1 个 Pod，经 WebShell 读；抽查的 `.ser` 是 1 字节占位，见流程第 2 步） | 线上 `decision_agent_server_java` 实例：prod 是 4 台虚拟机（多台时比对 md5）；pre 只有 1 个 Pod |
| bastion profile | `dev` | `online`（需用户授权只读访问） |
| 上传凭据 | `store.js` `upload_config` 的 stable 分支 | `store.js` `upload_config` 默认分支 |
| oss-fk 地址 | `oss-fk.oa.fenqile.com` 解析到 stable 内网地址（本地配置 `OSS_FK_STABLE_IP`，脚本用 `--resolve`） | `oss-fk.oa.fenqile.com` 正常 DNS |
| 迁移调用环境 | stable 的 `server_hawk_decision_manage` | 预发布的 `server_hawk_decision_manage`；预发布连的是线上库，迁移结果即线上数据 |

stable 与线上的上传凭据和地址不同（据此推断存储不互通，未实测），stable 上传得到的 `filePath` 不要拿到预发布用，反之亦然。线上三个环境共用同一个 `filePath`，上传一次即可。

## 流程

1. **先找现成 XML**：同一个包已迁移过时，优先复用已核对过的本地 XML（Hawk 工作区里通常是 `~/projects/backend/hawk/<包名小写>_ser_rules/<包名>.xml`），确认它就是线下验证通过的版本（比对修改时间、上次上传记录），然后直接跳到第 5 步。不要每次都从服务器重新生成，重新生成会丢掉人工修正。
2. **定位 SER 文件**：用 `query-app-instances` 查 `decision_agent_server_java` 在目标环境（线下 `stable`，线上 `prod`）的实例。先看 `query-app-instances` 返回的实例类型：只有 `instances.vm` 里的虚拟机 IP 能经堡垒机 `go <ip>` 进入；`instances.pod` 里的 Pod IP 用堡垒机进不去（2026-11-11 实测 `go` stable Pod `10.9.226.185` 失败）。2026-11-11 乐效登记的部署：stable 和 pre 各只有 1 个 Pod、没有虚拟机，prod 是 4 台虚拟机、没有 Pod。实例是 Pod 时用 `$AGENT_TOOLS_ROOT/skills/lexin/java-server-diagnostics/scripts/pod_file_fetch.js`（`--url` 取该 Pod 的 `login_pod_addr`，`--action=list|stat|fetch`，用法见 `java-server-diagnostics` 的“从 Pod 里只读取一个文件”）：`list` 找文件、`stat` 记下 size 和 md5、`fetch --out=<scratchpad 路径>` 一次取回并自动校验，不需要分块，也不要改写日志脚本或手工拼 WebShell 命令。取到的文件先看 size：2026-11-11 实测 stable Pod 上抽查的三个包（`student` 的 master 与 salve、`FQLDHJYD` 的 salve）的 `.ser` 都只有 1 字节，是占位文件，不能用于解析或迁移；pre Pod 上同名的 `FQLDHJYD` 包是 536737 字节、修改时间 2024-06-04（随镜像带入，不一定等于 prod 当前版本）。目标环境的 `.ser` 是 1 字节占位或 Pod 通道不可用时停下报告，请用户二选一：提供或确认本地已有的 XML（第 1 步），或授权从 prod 虚拟机只读拉取同名包（拉到的是线上版本，要向用户说明它不一定等于 stable 上部署的版本）。实例是虚拟机时，按上表 profile `connect_bastion` 后只读执行：
   ```bash
   ls -lt /home/publish_product/server_java/decision_agent_server_java/decision_ser_file/ | grep -i <包名>
   ls -lt /home/publish_product/server_java/decision_agent_server_java/decision_ser_file/salve_decision_agent_server_ser_<包名小写>/ | head
   stat -c %s FILE && md5sum FILE
   ```
   取最新修改时间的文件（或按部署表版本对应）。目录名里的 `salve` 是源码原文拼写。
3. **拉取并校验**：按 `parse-experian-ser` 第 2、3 步分块 base64 拉取、组装并校验 size/md5。原始 `.ser` 只放会话 scratchpad。
4. **转 XML 并人工核对**：
   ```bash
   $AGENT_TOOLS_ROOT/skills/lexin/parse-experian-ser/scripts/ser_render.sh WORKDIR/X.ser xml > WORKDIR/X.xml 2> WORKDIR/X.warn
   ```
   `X.warn` 里的 `WARN` 和 XML 里的 `UNSUPPORTED` 标记必须逐条处理后才能上传。组件名默认不加后缀；只有要求迁移新建一套组件时才传第 3 个参数作后缀。XML 含线上规则：不进 Git、不出公司。
5. **上传拿 filePath**：
   ```bash
   $AGENT_TOOLS_ROOT/bin/with-env python3 -I scripts/upload_transfer_file.py \
     --env stable|online --file WORKDIR/X.xml --name <包名>.txt
   ```
   输出 `{"ok":true,"filePath":"/fehawkdecision.../M00/ex/...txt"}`。凭据只在脚本进程内读取，经 stdin 传给 curl，不进命令行参数，不打印、不落盘。`--env stable` 需要在 `env/credentials.env` 配置 `OSS_FK_STABLE_IP`，缺失时脚本报错退出。线上上传前向用户说明会把规则内容写入线上文件服务。
6. **交接**：把 `filePath`、目标环境和本地 XML 的 size/md5 交给迁移调用方。调用前先 `dubbo_dry_run` 预览入参 `[{"operator":"<min>","appId":<appId>,"filePath":"<上一步结果>"}]`，等用户确认后再调。接口是 `com.fenqile.rc_comm.hawk.decision.manage.transfer.service.TransferService#transfer`（版本 `2.0.0`），要验证新代码时用乐效查到的新版本 Pod 地址，端口 `31104`。

## 交接给迁移调用方的注意事项

- **同一字段的状态可能两边不同：** 迁移前按 SER 输入字段在目标环境查字段表 `hawkeye_decision_engine_db.t_rcrule_data_field`（实例 `HawkDecisionDB`），确认是否有下线字段。字段平台 `pageQuery4Hawk` 只返回上线字段，同一字段可能在 stable 上线、线上下线，所以 stable 验证通过不代表线上字段状态相同。
- **调用失败先查再重试：** 迁移不是幂等操作。调用报 `Failed to fetch` 等网络错误时，先查 `t_strategy_node_field` 的最新版本和修改时间，确认没有写入再重试。
- **迁移后核对：** 重复迁移会基于上一版本生成新草稿，复制来的记录保留原创建时间，要按最新版本号核对，不要按创建时间查。核对该版本没有字段名为空的有效输入字段，且下线字段带真实的字段 ID 和方法 ID。
- **规则测试页不等于迁移结果：** `rule_test_detail.json` 只返回上线字段，下线字段没有输入框，用到它们的规则测试时可能报错，这不代表迁移写错。

## 失败处理

- `connect_bastion` 返回“要求输入安全码”：弹出输入框向用户要一次当前 6 位 MOA 码，带 `otp` 重连；返回“要求输入密码”：请用户在 bastion 的 `config.json` 填 `password`。报 `Error reading SSH protocol banner`、命令结果是“命令没有在目标机执行”或 `Socket is closed`：按 MCP/网络故障停下报告，不重复向用户要码，不换通道绕过。
- 上传返回 `ok:false`：报告 `retcode/retmsg`，核对 `--env` 与凭据分支是否一致；不改用别的上传接口。
- `store.js` 结构变化导致取不到凭据：按 `upload_config` 的新写法修脚本，不把凭据复制进脚本或命令行。
- 迁移报读不到文件：先确认 `filePath` 是在调用环境对应的文件服务上传的（见环境对照）。
- 迁移报 `变量未找到[字段名]`：字段平台和 `t_rcrule_data_field` 都查不到这个输入字段。该表只有索骥字段，特征和 CDP 标签要到字段平台核对；不要改 XML 绕过。

## 边界

- 服务器上只执行 `ls`、`stat`、`md5sum`、`tail -c | head -c | base64` 等只读命令。
- 会话 scratchpad 里的 `.ser`、XML、`tool-results/` 中的 base64 原文，交付后删除。
