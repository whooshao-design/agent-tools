---
name: verify-java-coverage
description: Use when Java/Maven 改动需要满足任务、仓库或乐效流水线的覆盖率门禁（乐效单测红线：增量代码行覆盖率 ≥90%），或需要用 JaCoCo 分析改动行、跨模块聚合、报告可信度和补测缺口，或乐效增量覆盖率报告偏低要查原因时。
metadata:
  version: 1.2.0
---

# verify-java-coverage

## 定位

用于作为 `dev-verify-change` 的 Java 覆盖率专项执行器，处理 Maven、JaCoCo、改动行与跨模块覆盖率证据。

它聚焦覆盖率证据与补测判断，不替代主验证流程里的最小验证结论。

默认不作为通用主入口；在任务/仓库要求 Java 覆盖率、主验证需要专项证据，或用户明确点名时使用。

## When to Use

适合以下场景：
- Java / Maven 项目需要执行任务或仓库定义的覆盖率门禁
- 变更跨多个模块，基础验证无法准确反映真实覆盖情况
- 需要判断改动行覆盖、报告可信度，或定位未覆盖分支并给出补测建议

不适合以下场景：
- 项目不是 Java / Maven / JaCoCo 体系
- 任务和仓库都没有覆盖率要求，现有功能证据已足够且不需要专项诊断

## 检查骨架

重点检查：
- 模块结构：测试代码与生产代码是否跨模块分离
- 覆盖率来源：JaCoCo 配置是否可用，报告是否可信
- 变更粒度：优先看本次改动涉及的类、方法和变更行
- 阈值事实源：依次读取用户/任务验收条件、实际执行的 CI/质量门禁配置（乐效构建的应用即乐效单测红线，见下节）、仓库文档；除乐效红线外不内置统一阈值
- 门控结论：工具支持且门禁适用时优先计算新增/修改可执行行覆盖率；没有明确阈值时只报告观测值，不宣称达标
- 补测方向：优先补哪些分支、异常路径和边界条件

## 乐效流水线增量覆盖率门禁

应用由乐效构建时，乐效单测红线就是门禁事实源：用例通过率 100%，增量代码行覆盖率 ≥90%（乐效红线规定更高时从高）。不得因本地测试全绿、或本地整类覆盖率高而宣称达标。

流水线只统计部分模块里测试产生的覆盖率，测试放错模块会“跑了但不计数”。例：流程引擎 `process-app` 的 `jacoco-maven-plugin` 只 `include` `**/service/**`、`**/controller/**`，放在 `process-app` 的 `component` 包测试在流水线里覆盖率为 0，要放到 `process-engine-start` 这类整包统计的模块。

1. **确定统计口径：** 读各模块 `jacoco-maven-plugin` 的 `includes`/`excludes`、surefire 的 `suiteXmlFile` 与 `skip` 配置，列出“哪些模块的测试会被计入、能覆盖哪些包”。拿不准时以乐效增量报告里已覆盖类所在的测试模块为准。
2. **测试放到计数的模块：** 新增或迁移测试时，被测类必须落在该模块的统计范围内；不满足就换模块（同包名放在被统计的测试模块），不改流水线或 `pom.xml` 的统计范围来凑数。
3. **按同一口径本地复算：** 只跑第 1 步的模块，用 JaCoCo agent 采集（`-Djacoco.skip=true` 避免与仓库插件重复），CLI 生成 XML，再算改动行覆盖率：

   ```bash
   AG=~/.m2/repository/org/jacoco/org.jacoco.agent/0.8.11/org.jacoco.agent-0.8.11-runtime.jar
   mvn -o test -pl <计数的模块,逗号分隔> -Djacoco.skip=true -Dmaven.test.failure.ignore=true \
     -DargLine="-javaagent:$AG=destfile=<临时目录>/cov.exec,append=true,includes=<基础包>.*"
   java -jar ~/.m2/repository/org/jacoco/org.jacoco.cli/0.8.11/org.jacoco.cli-0.8.11-nodeps.jar report <临时目录>/cov.exec \
     --classfiles <每个模块>/target/classes ... --sourcefiles <每个模块>/src/main/java ... --xml <临时目录>/cov.xml
   python3 /home/joney/projects/ai/agent-tools/skills/dev-quality/verify-java-coverage/scripts/diff_coverage.py \
     --base master --report <临时目录>/cov.xml --threshold 90
   ```

   `--classfiles` 要包含全部改动所在模块，否则脚本报 `NO_DATA` 并以退出码 2 结束；退出码 1 表示低于门槛。被测依赖模块的改动要先 `install` 到本地仓库再跑下游模块测试。
4. **补测到 ≥90%：** 按 `miss=` 行号补分支、异常和边界用例。确实不可达的防御代码优先删掉或改成可覆盖的等价写法，不靠排除规则绕过。
5. **推送后以乐效报告为准：** 打开该构建的增量覆盖率报告（`.../unitcov/<构建号>/report/<时间戳>/increce.html`），逐类核对“有效变更行 / 已覆盖变更行”。本地复算与乐效不一致时先查统计口径，不能拿本地结果代替。

## 临时配置保护

仓库未配置可用 JaCoCo 时，优先使用 Maven 命令行参数、`-javaagent` / JaCoCo CLI 或临时目录中的配置副本，不先修改工作区 `pom.xml`。

确需临时修改时：

1. 先记录 `git status --short`、未暂存/已暂存 diff，并保存目标文件哈希；目标 `pom.xml` 已有未提交修改时不做原地临时 patch。
2. 只施加可独立反向应用的最小 patch，不使用会覆盖整文件或其他改动的恢复命令。
3. 完成后只反向撤销自己的 patch；不得用 `git checkout`、`git restore` 或 reset 清除用户改动。
4. 再次记录状态、两类 diff 和目标文件哈希，与修改前快照比较；临时 patch 必须为零，原有业务 diff 必须逐字节保持。无法证明恢复时停止交付并报告残留。

## 使用原则

- 由 `dev-verify-change` 汇总功能与覆盖率结论，本 skill 只对覆盖率证据负责
- 优先围绕本次变更收集覆盖率证据，不扩大成全仓普查
- 跨模块时优先确认报告是否遗漏真实生产类
- 不用全仓覆盖率或整类覆盖率替代改动行覆盖率；整类覆盖率只能作为辅助风险说明
- 门控失败时给出补测建议，而不只报一个百分比
- 没有框架且无覆盖率门禁时报告“不适用”，交回定向测试/静态检查/人工检查等替代证据，不循环安装工具
- 门禁要求证据但环境无法生成，或覆盖率数据不可信时，说明替代证据和限制，不能宣称门禁通过

## 输出要求

输出至少包括：
- 覆盖率检查范围与模块结构判断
- 适用门禁、阈值及其事实来源；没有阈值时明确说明
- 覆盖率生成方式；使用临时配置时附清理结果和修改前后 diff 一致性证据
- 报告是否可信，是否存在跨模块遗漏风险
- 改动行证据（适用且可生成时）、关键覆盖率结论与门控结果
- 未覆盖重点与补测建议

## 交接建议

- 覆盖率结论回交 `dev-verify-change` 汇总整体验证结论
- 若发现问题本质是实现遗漏，回到 `dev-build-change`
