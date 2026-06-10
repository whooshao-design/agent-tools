---
name: fix-sonarqube-issues
description: Use when 需要评估并修复 SonarQube 新代码周期内的 BLOCKER/CRITICAL 级别代码质量问题。评估优先，不该修的不硬修；通过 API 拉取问题清单、逐条评估是否需要修复、仅修复确认安全的项、验证编译通过后汇总结果。
version: 1.1.0
---

# fix-sonarqube-issues

## 定位

用于**评估并处理** SonarQube 新代码周期内的 BLOCKER / CRITICAL 级别代码质量问题。

核心原则：**评估优先，修复其次。** 每条问题先判断是否真的需要修复、修复是否安全；不该修的坚决不修，宁可标注"无需修复+理由"，也不能硬修引入运行时 bug 或破坏监控契约。

## When to Use

适合以下场景：
- SonarQube 新代码周期内出现 BLOCKER 或 CRITICAL 级别问题，阻断质量门禁
- 需要系统性地评估每条问题是否需要修复
- 需要对可安全修复的问题做最小改动
- 已有 SonarQube 认证信息（浏览器 Cookie 中的 JWT-SESSION、XSRF-TOKEN）

不适合以下场景：
- SonarQube 问题为 BUG 或 VULNERABILITY 类型（需人工评估安全影响）
- MAJOR/INFO 级别问题（不在本 skill 范围）
- 问题涉及架构级重构，不能通过局部修改解决
- 没有可用的 SonarQube 认证信息，且内网不可达

## 用户需提供的信息

只需两项：

1. **SonarQube 问题页面 URL**
   格式示例：`https://sonarqube.oa.fenqile.com/new_sonar/project/issues?resolved=false&severities=CRITICAL&inNewCodePeriod=true&id=project%3Agit_push_check_{repo_name}`
   从中可自动提取 SonarQube 基地址和项目 ID（URL 的 `id` 参数值）。

2. **认证信息**（两种形式均可）：
   - 浏览器开发者工具 Network 面板 → 复制任意 SonarQube 请求的完整 curl 命令（自动提取 XSRF-TOKEN 和 JWT-SESSION）
   - 直接提供 `XSRF-TOKEN` 和 `JWT-SESSION` cookie 值

获取方式：浏览器登录 SonarQube → F12 开发者工具 → Network → 找到任意请求 → 右键"Copy as cURL(bash)"。

## Workflow

### 1. 提取项目信息与认证

从用户提供的 URL 或 curl 命令中提取：
- **SonarQube 基地址**：如 `https://sonarqube.oa.fenqile.com/new_sonar`
- **项目 ID**：URL `id` 参数的值（如 `project:git_push_check_server_hawk_decision_dispatcher`）
- **XSRF-TOKEN**：从 curl 的 `-H "X-XSRF-TOKEN: ..."` 或 Cookie 中提取
- **JWT-SESSION**：从 curl 的 `-b` Cookie 中提取

### 2. 拉取问题清单

构造 SonarQube API 调用：

```bash
curl -s "{SONARQUBE_BASE}/api/issues/search?resolved=false&severities=BLOCKER,CRITICAL&inNewCodePeriod=true&componentKeys={PROJECT_KEY}&ps=100" \
  -H "Accept: application/json" \
  -H "X-XSRF-TOKEN: {XSRF_TOKEN}" \
  -b "XSRF-TOKEN={XSRF_TOKEN}; JWT-SESSION={JWT_SESSION}"
```

参数说明：
- `severities=BLOCKER,CRITICAL`：只拉阻断和严重问题
- `inNewCodePeriod=true`：只扫新代码周期，避免处理历史遗留
- `ps=100`：单页最大条数

解析 JSON 返回的 `issues` 数组，提取每个 issue 的：
- `rule`：规则 ID
- `component`：受影响文件路径（含项目前缀）
- `line`：行号
- `message`：问题描述
- `severity`：严重级别（BLOCKER / CRITICAL）
- `textRange`：精确文本范围（startLine, endLine, startOffset, endOffset）

将 `component` 中的项目前缀去除，得到相对文件路径。例如：
`project:git_push_check_server_hawk_decision_dispatcher:server-hawk-decision-dispatcher-core/src/main/java/.../Foo.java`
→ `server-hawk-decision-dispatcher-core/src/main/java/.../Foo.java`

### 3. 逐条评估是否需要修复

**这是最关键的步骤。** 对每条问题做以下判断：

#### 3a. 判断是否为误报

常见误报场景：
- **lambda 内引用未被检测**：SonarQube 的 `lx-squid:LxUnusedPrivateFieldCheck` 等规则可能无法检测 lambda/匿名类内的字段引用。用 grep 搜索字段名在文件中的所有出现次数，如果 ≥ 2（定义行 + 使用行），则为误报。
- **反射/序列化隐式引用**：被 JSON 序列化、反射调用、Spring 注入的字段看似"未使用"，但实际在运行时被访问。
- **日志监控契约**：硬编码类名字符串常用于日志/监控上报的 `className` 参数，与 `CLASS_NAME` 常量值相同但不一定适合替换（例如日志要求稳定的字面值，换常量后改名会破坏监控一致性）。

#### 3b. 判断修复是否安全

即使 SonarQube 标注正确，修复也可能不安全：
- **删掉"未使用"字段**：如果 grep 只找到定义行但该字段可能在子类、反射、序列化中被使用，删除可能导致运行时错误。
- **替换硬编码字符串为常量**：如果常量名语义不够清晰、未来可能被重命名导致所有引用点联动变更，硬编码反而更稳定。
- **改 isEmpty 代替 size**：如果 `size()` 有并发语义（如 ConcurrentHashMap 的 size() 是近似值而 isEmpty() 检查的是真实状态），替换可能改变行为。

#### 3c. 做出判定

每条问题必须给出明确判定：

| 判定 | 条件 | 动作 |
|------|------|------|
| **需修复** | 问题真实且修复安全，改动不会引入运行时风险 | 执行最小必要修改 |
| **无需修复** | 误报（有实际引用但 SonarQube 检测不到），或修复不安全（会引入风险或破坏契约） | 标注理由和代码证据，不做任何改动 |
| **需人工** | 无法在当前上下文范围内判断是否安全 | 列出问题和建议方向，不做任何改动 |

### 4. 执行确认安全的修复

只对判定为"需修复"的问题执行修改。按文件分组，逐文件读取并修改：
- 优先复用现有常量和代码模式
- 保留原有代码风格和注释习惯
- 同一文件多个问题一起处理
- 不顺手做无关重构、清理或风格统一

**java:S1192（重复字符串常量）修复步骤——仅在确认安全后执行：**
1. 读取受影响文件全文
2. 定位到 SonarQube 标注的行号，确认硬编码字符串的值
3. 搜索同文件中是否已有 `private static final String XXX = "该值"` 的常量定义
4. 有常量 → 确认替换不会破坏监控/日志契约 → 将硬编码字符串替换为常量名
5. 无常量 → 确认新增常量不会导致维护耦合 → 新增常量定义并替换引用

**安全检查点：**
- 该字符串是否用于监控上报的 className/methodName 参数？替换为常量后，常量重命名会联动影响所有上报点 → 如果监控契约要求稳定字面值，标注"无需修复"
- 该常量是否在同一文件中被多处引用？如果只有 1-2 处引用且值不会变更，硬编码反而更明确 → 考虑标注"无需修复"

**未使用字段修复步骤——仅在确认安全后执行：**
1. 用 grep 搜索该字段名在文件中的所有引用（注意 lambda 内引用）
2. 引用数 ≥ 2 → **误报，标注"无需修复"**，附代码行号证据
3. 引用数 = 1（仅定义行）→ 进一步检查是否被反射/序列化/子类使用 → 无法确认则标注"需人工"
4. 确认完全未使用且无运行时依赖 → 删除字段定义行及相关空行

**其他规则的评估与修复逻辑同理：先确认安全，再决定是否动手。**

### 5. 验证编译

仅对有修改的文件执行最小编译验证：

```bash
mvn compile -q
```

确认修改后代码仍可编译通过。如编译失败，回退修改并标注"修复失败"。

### 6. 汇总结果

输出评估与修复结果表格：

| 规则 | 文件 | 行号 | 判定 | 说明 |
|------|------|------|------|------|

判定分类（四类，不是三类）：
- **已修复**：问题真实、修复安全、代码已改动、编译验证通过
- **无需修复**：误报（附代码行号证据），或修复不安全（附风险说明），不做任何改动
- **需人工**：无法在当前上下文判断是否安全，列出问题和建议方向
- **修复失败**：执行了修改但编译失败，已回退

务必区分"无需修复"和"需人工"——"无需修复"是已有充分证据可以不做修改，"需人工"是证据不足需要人判断。

加编译验证结论和 SonarQube 重新扫描建议。

## 评估与修复原则

- **评估优先，修复其次**——不该修的坚决不修
- 只做最小必要改动，不顺手重构或清理
- 优先复用已有常量，但替换前必须确认不会破坏监控/日志契约
- 保留现有代码风格和约定
- 对不确定的问题标注为需人工评估，**绝不猜测修复**
- 误报必须附代码行号级证据，不能只说"可能是误报"
- 修复不安全的问题标注"无需修复"并附风险说明，不能硬修
- 同文件多问题合并评估，避免碎片化判断
- 只处理 BLOCKER/CRITICAL，MAJOR/INFO 级别不在本 skill 范围

## 输出物

一份评估与修复结果表格，至少包括：
- 已修复问题：规则、文件、行号、修复方式
- 无需修复问题：规则、文件、行号、判定理由与代码证据
- 需人工问题：规则、文件、行号、建议方向
- 修复失败问题：规则、文件、行号、失败原因（如有）
- 编译验证结论（通过 / 失败 / 无改动无需验证）
- 下一步建议

## 结果要求

一份合格的评估结果应满足：
- 每条问题都有明确判定，不能留"未分类"
- "无需修复"必须附充分证据（代码行号、运行时依赖分析），不能只凭直觉
- 已修复的问题能证明修复不会引入新风险
- 编译验证覆盖所有有改动的文件
- "无需修复"的问题在 SonarQube 上仍会显示为 OPEN，需告知用户后续处理方式（如标记 Won't Fix、添加 NO_SONAR 注释等）

## 可选增强

- 如需修复 BUG 或 VULNERABILITY 类型问题，先转 `dev-review-change` 做安全评审
- 如修复后需做代码评审，可调用 `dev-review-change`
- 如修复后需做专项验证，可调用 `dev-verify-change`
- 对于"无需修复"的误报问题，可在代码中添加 `// NOSONAR` 注释让 SonarQube 忽略该行（需用户确认）

## 交接建议

- 修复完成后，提交代码并在 SonarQube 上确认问题关闭
- "无需修复"的误报问题：建议在 SonarQube 上标记为 Won't Fix，或在代码行加 `// NOSONAR`
- 如有需人工评估的问题，转给对应模块负责人
- 如需扩大验证范围，转 `dev-verify-change`