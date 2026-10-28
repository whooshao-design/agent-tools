# 后端 Java 开发细则

写集含 `.java`、`pom.xml`、MyBatis XML、Dubbo/Spring 配置或其他 Java 服务资源时读取本文件。阶段流程、DEV 清单和简洁性要求仍以主文件与 `implementation-simplicity.md` 为准；本文只放 Java/Maven 后端特有的做法。

## 1. 编码前必读

- 读目标仓库及沿途的 `AGENTS.md`，确认实际仓库根、模块分层（如契约在 `...-service`、核心逻辑在 `...-core`/`...-logic`、装配在 `...-impl`）和运行时应用名（以 `app.properties`/`application.name` 为准）。
- 读目标模块 `pom.xml` 的 parent、Java 版本、关键依赖版本和 profile；不要把一个项目的 Java 版本、profile 或测试约定套用到相邻仓库。
- 找同类实现时，先看相同分层里已有的 service/logic、DAO 与 MyBatis XML、异常和日志写法，默认沿用。

## 2. 测试布局

新增或迁移单测时，按仓库文档、Surefire/TestNG suite 配置或实际执行结果证明的布局放置。仅存在 `mock` 目录不能推出所有测试都必须进入 `mock.*` 包；只有证据表明 suite 或门禁按该包发现测试时才应用这条约束。

应用由乐效构建时，测试还要放在流水线覆盖率统计得到被测类的模块：核对该模块 `jacoco-maven-plugin` 的 `includes`/`excludes`，被测类不在范围内就把测试放到整包统计的模块（例：流程引擎 `process-app` 只统计 `service`、`controller` 包，`component` 包的测试放 `process-engine-start`）。编码收尾前按 `verify-java-coverage` 的乐效口径确认改动行覆盖率 ≥90%。

## 3. 注释

- 线程池、缓存等资源的归属与生命周期不明显时，在类或字段上说明谁创建、谁关闭、作用范围多大。
- 普通注释默认不用 HTML 标签；正式 JavaDoc 仅在多段说明或项目既有风格需要时使用 `<p>`。

## 4. 契约与发布

- 修改 `service`、`client`、`spi` 等对外契约时，核对直接调用方；依赖已发布 artifact 的调用方不会随当前 reactor 一起编译。
- 前后端产物各写各的：Hippo 等后端配置写进后端发布计划，不写进前端产物。

## 5. 自检与专项

- 编码后的最小自检优先用仓库文档给出的命令，例如 `mvn -f <service>/pom.xml -pl <module> -am compile`；测试执行与 suite 参数见 `dev-verify-change` 的 `references/test-execution-routing.md`。
- 需要对齐幂等、异常处理、事务边界、分层写法时调用 `lang-java-service-patterns`；涉及 SQL/DDL/事务一致性或中间件可靠性时，评审阶段补 `review-db-change`、`review-middleware-reliability`。
