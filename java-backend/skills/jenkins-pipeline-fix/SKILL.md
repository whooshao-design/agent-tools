---
name: jenkins-pipeline-fix
description: 诊断或修复 Jenkins 流水线失败。支持 mode=diagnose/fix-tests/fix-build/auto，从 Jenkins URL 或当前 git 项目推断流水线，读取构建阶段、consoleText、编译错误和测试报告；默认只读诊断，只有用户明确要求修复时才改代码，只有明确要求时才提交或推送。
version: 1.0.0
---

# Jenkins 流水线诊断与修复

## 核心原则

- **默认只诊断**：没有明确说"修"、"改"、"让它过"时，不修改代码。
- **先定位，后修复**：先判断失败阶段和根因，再决定是否进入修复流程。
- **参数化执行**：用 `mode`、`job_url`、`wait`、`fix`、`push` 控制行为，减少用户输入。
- **最小改动**：只修改与本次失败直接相关的代码或测试。
- **本地验证**：有修改必须运行最小有效验证；只有用户明确要求时才提交或推送。

## 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `auto` | `diagnose` 只读排查；`fix-tests` 修失败单测；`fix-build` 修编译/打包失败；`auto` 按用户语义和失败阶段判断 |
| `job_url` | `auto` | Jenkins 构建 URL；为空时从当前 git 项目推断 |
| `wait` | `true` | 构建运行中时是否轮询等待完成 |
| `fix` | `false` | 是否允许改代码；`auto` 只有用户明确要求修复时才设为 true |
| `push` | `false` | 是否允许提交或推送；永远不能自动开启 |

### 自然语言映射

- "排查这个 Jenkins 失败：<url>" -> `mode=diagnose job_url=<url> fix=false push=false`
- "这个流水线为什么失败" -> `mode=diagnose job_url=auto fix=false push=false`
- "帮我修这次流水线失败单测" -> `mode=fix-tests job_url=auto wait=true fix=true push=false`
- "帮我修编译失败" -> `mode=fix-build job_url=auto wait=true fix=true push=false`
- "修好并推上去" -> 只有这类明确语义才允许 `push=true`

`auto` 模式规则：如果用户没有明确要求修复，退回 `diagnose`。如果用户明确要求修复，但失败阶段不是单测或编译失败，先诊断并说明需要人工确认。

## 输入与流水线地址

优先使用用户给的完整 Jenkins URL：

```text
https://devops-jenkins.oa.fenqile.com/job/<pipeline_name>/<build_number>/
```

未提供 URL 时，从当前 git 项目推断：

```bash
PROJECT=$(git remote get-url origin 2>/dev/null | sed 's/.*\///; s/\.git//')
BRANCH=$(git branch --show-current)
JENKINS_URL="https://devops-jenkins.oa.fenqile.com/job/feature-pipeline-${PROJECT}-${BRANCH}/"
curl -s --max-time 10 "${JENKINS_URL}lastBuild/api/json?tree=number,result,building" 2>/dev/null
```

如果返回 404 或项目不在 git 仓库中，请用户提供完整流水线 URL 或流水线名称 + 构建号。

## Jenkins API

| 用途 | URL |
| --- | --- |
| 构建状态 | `<JOB_URL>/api/json?tree=result,building,displayName,number` |
| 最新构建 | `<JOB_URL>/lastBuild/api/json?tree=result,building,displayName,number` |
| 阶段状态 | `<JOB_URL>/wfapi/` 或 `<JOB_URL>/lastBuild/wfapi/` |
| 全量日志 | `<JOB_URL>/consoleText` 或 `<JOB_URL>/lastBuild/consoleText` |
| TestNG 报告 | `<JOB_URL>/lastBuild/testngreports/api/json` |

所有 `curl` 默认加 `--max-time 30`；拉 `consoleText` 可用 `--max-time 60`。

返回 403 时，提示用户提供 Jenkins Cookie 或 API Token，并在 curl 中加 `-b '<COOKIE>'` 或认证 header。不要在最终回复中输出完整 Cookie。

## 工作流程

### 1. 确定执行模式

1. 解析用户是否提供 `mode/job_url/wait/fix/push`。
2. 未显式提供时按自然语言映射推断。
3. 如果用户只问原因、排查、为什么失败：`mode=diagnose fix=false push=false`。
4. 如果用户要求修复：`fix=true`，但 `push` 仍默认 false。
5. 明确告诉用户当前采用的模式，例如：`mode=diagnose, wait=true, fix=false, push=false`。

### 2. 获取构建状态

```bash
curl -s --max-time 30 '<JOB_URL>/api/json?tree=result,building,displayName,number' | python3 -m json.tool
```

如果使用的是 job 根路径而非具体 build 路径，改用：

```bash
curl -s --max-time 30 '<JOB_URL>/lastBuild/api/json?tree=result,building,displayName,number' | python3 -m json.tool
```

构建仍在运行且 `wait=true` 时，每分钟轮询，默认最多 30 分钟：

```bash
for i in $(seq 1 30); do
  curl -s --max-time 30 '<JOB_URL>/lastBuild/api/json?tree=result,building,displayName,number' > /tmp/jenkins_last_build.json
  python3 - <<'PY'
import json
data = json.load(open('/tmp/jenkins_last_build.json'))
print(f"build={data.get('displayName')} building={data.get('building')} result={data.get('result')}")
PY
  python3 - <<'PY' && break || true
import json, sys
data = json.load(open('/tmp/jenkins_last_build.json'))
sys.exit(0 if not data.get('building') else 1)
PY
  sleep 60
done
```

如果 `wait=false` 且构建仍在运行，只报告当前状态并结束。

### 3. 读取阶段并定位首个失败点

```bash
curl -s --max-time 30 '<JOB_URL>/lastBuild/wfapi/' | python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('stages', []):
    status = s.get('status','?')
    error = s.get('error','')
    name = s.get('name','?')
    print(f'{name}: {status}' + (f' | {error.get(\"message\",\"\")}' if error else ''))
"
```

优先关注**第一个 FAILED 阶段**。后续 FAILED 阶段常常是被上游失败连带跳过。

| 失败阶段 | 典型根因 | 默认动作 |
| --- | --- | --- |
| `CHECKOUT` | 分支不存在、代码冲突、权限问题 | 诊断并给出分支/仓库检查建议 |
| `ARTIFACT` | 编译失败、依赖缺失、打包失败 | `diagnose` 只报告；`fix-build` 才改代码 |
| `UT-DEFAULT` | 单元测试失败 | `diagnose` 只报告；`fix-tests` 才改代码 |
| `SAFETY-CHECK` | 安全扫描或质量门禁 | 诊断并建议转相应安全/质量流程 |
| 其他阶段 | 部署、上传、通知等问题 | 结合日志诊断，默认不改代码 |

### 4. 拉取日志并分类

```bash
curl -s --max-time 60 '<JOB_URL>/lastBuild/consoleText' > /tmp/jenkins_log.txt

# 编译错误
grep '\[ERROR\]' /tmp/jenkins_log.txt | grep -v 'Help 1' | grep -v 'stack trace' | grep -v 'Re-run' | grep -v 'MavenExecutionException' | head -80

# 测试失败摘要
grep -E 'Tests run:.*Failures:.*Errors:' /tmp/jenkins_log.txt | grep -v 'Failures: 0' | tail -10

# 业务异常总结
grep '构建过程发生业务异常' /tmp/jenkins_log.txt || true
```

诊断模式到这里即可输出结论：失败阶段、关键日志、根因判断、建议动作。不要修改代码。

## 修复模式

只有 `fix=true` 时进入本节。

### fix-tests：修失败单测

先获取结构化测试报告：

```bash
curl -s --max-time 30 '<JOB_URL>/lastBuild/testngreports/api/json' | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Tests: {data.get('total', 0)}, Failures: {data.get('failCount', 0)}, Skipped: {data.get('skipCount', 0)}\")
for pkg in data.get('package', []):
    if pkg.get('fail', 0) > 0:
        print(f\"Package: {pkg['name']}, Failures: {pkg['fail']}, Total: {pkg['totalCount']}\")
"
```

如果 TestNG API 不可用，从日志提取：

```bash
grep -E 'FAILED:|FAILURE|Tests run:.*Failures:.*Errors:' /tmp/jenkins_log.txt | head -80
```

定位测试和源码：

```bash
find . -path '*/src/test/*' -name '<TestClassName>.java'
find . -path '*/src/main/*' -name '<ClassName>.java'
```

判断标准：

| 情况 | 判断依据 | 修复方向 |
| --- | --- | --- |
| 新功能添加字段但旧测试未更新 | 测试数据缺字段，代码预期新字段 | 修改测试数据或断言 |
| 旧数据兼容问题 | 旧数据缺字段但业务要求默认值 | 修改代码兼容旧数据 |
| 代码 bug | 断言合理，代码返回错误 | 修改代码 |
| 测试期望过时 | 业务逻辑已变更，测试仍按旧行为断言 | 修改测试 |
| 环境问题 | 依赖 Redis/DB/外部资源不可用 | mock 外部依赖或标注环境问题 |

验证：

```bash
mvn test -pl <module> -Dtest=<TestClassName>#<methodName> -q
```

必要时再运行受影响模块的 `mvn test` 或 `mvn compile`。

### fix-build：修编译/打包失败

常见模式：

- `cannot find symbol: class Xxx`：新文件未加入 git、包路径错误、依赖模块未编译。
- `cannot find symbol: method xxx`：方法签名变更后调用方未同步。
- `package ... does not exist`：依赖缺失或 pom 配置错误。
- `Compilation failure`：语法错误或泛型/注解处理错误。

修复前先在本地复现：

```bash
mvn compile -q
```

多模块项目优先定位失败模块，再运行：

```bash
mvn -pl <module> -am compile -q
```

只修改导致编译失败的最小代码或配置。修复后重复相同命令验证。

## 提交与推送

默认不提交、不推送。只有用户明确要求时才执行：

```bash
git status --short
git add <changed-files>
git commit -m "fix: 修复 Jenkins 流水线失败"
git push
```

提交前必须确认：

- 已说明修改的是代码问题还是测试问题。
- 已运行最小验证且通过。
- `git status` 中没有无关文件。
- 不包含 Cookie、Token、日志大文件或本地临时文件。

## 输出格式

诊断模式：

```text
模式: diagnose
流水线: <JOB_URL>
结果: FAILURE/UNSTABLE/...
首个失败阶段: <stage>
关键证据:
- <日志/阶段证据>
根因判断:
- <判断>
建议:
- <下一步>
```

修复模式：

```text
模式: fix-tests/fix-build
流水线: <JOB_URL>
根因: <代码问题/测试问题/环境问题/编译问题>
修改:
- <文件>: <改动摘要>
验证:
- <命令>: 通过/失败
提交/推送:
- 未执行 / 已按用户要求执行
```
