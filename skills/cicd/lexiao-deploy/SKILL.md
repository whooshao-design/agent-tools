---
name: lexiao-deploy
description: 乐效中部署和验收应用的流程技能。Use when 需要 open a Lexiao demand/version page, integrate branches, build an application, create or reuse a pre-release/gray publish order, deploy a project-environment artifact, or deploy exactly one pre-release/gray target with VM/KVM priority, then verify publish status, pipeline/artifact health, publish logs, target-server logs, and triage errors with next-step choices. Supports 项目环境/prj、预发布单机、显式灰度单目标 deployment; reserve OA、线上 rollout paths for future extension.
version: 1.1.0
---

# Lexiao Deploy

## 工具优先级

已注册 `lexiao` MCP 时，优先使用其工具完成本 skill 的查询与操作；MCP 不可用或未注册时，再按下文的脚本/HTTP 方式兜底。两者底层能力一致。


## Scope

Use this skill to deploy applications from Lexiao demand/version pages and verify the rollout. Supported flows:

- `项目环境` / `PROJECT` / `prj` deployment.
- `预发布` single-machine deployment when the user asks to deploy one machine or specifically mentions pre-release machines. Prefer virtual-machine/KVM targets; only deploy a container target when no VM/KVM target exists or the user explicitly asks for container.
- Full pre-release redeploy after code changes: branch integration, build, wait for artifact, create the correct publish order, deploy one VM/KVM, verify page/API and server logs, then triage errors and offer next-step choices.
- `灰度` deployment when explicitly requested by the user: skip branch integration and build, then otherwise follow the same publish-order, one-target-per-app, log-first verification, and sequential error gate used for pre-release.

When the user names multiple applications, build all target applications together after branch integration; build does not need to follow the Lexiao `发布顺序`. After triggering builds, check every target application's build and artifact result before opening any publish order. Only the publish/deploy/log-verification phase is sorted by `发布顺序` and operated in publish-order batches from the smallest value to the largest. Applications with the same `发布顺序` may be deployed and verified in parallel, for example by assigning one application per subagent or running independent status/log checks concurrently. For each application, deploy exactly one target by default, verify logs, and report the result. Do not deploy all machines of one app unless the user explicitly asks for all machines.

Sequential publish gate: do not start a later publish-order batch until every application in the current publish-order batch has completed log-first verification. If any application in the current batch fails, becomes ambiguous, or produces new deployment-window ERROR/Exception logs, first evaluate the error evidence and classify it as blocking, non-blocking, or unrelated. Continue to later publish-order apps only when the entire current batch is healthy or the user explicitly accepts the assessed risk.

Do not apply the project-environment or pre-release single-machine flow to `OA` or `线上`. For those environments, read the page and stop before deploy, then ask for the environment-specific publish procedure, approval constraints, rollout strategy, log targets, and rollback criteria.

## Inputs

Extract and report these fields before deployment:

- Lexiao URL, version ID, demand ID, demand name, online date when visible.
- Target app name and project name. Match exact row text; do not rely on button order alone.
- Environment IP, `GROUP`/SET, branch, developer, branch status, pipeline status, artifact status, deploy status, CR status.
- For pre-release: publish order ID, app ID, version tag, deployment type, selected machine IP, machine publish status, machine run status, and whether VM/KVM or container was selected.

If multiple app rows match or the target app is not explicit, ask for the app name before clicking anything.

## Click Safety

Lexiao pages often repeat the same buttons (`构建`, `部署详情`, `发布单`, `流水线详情`, `部署`) for every app and machine row.

- Use generic text click helpers only for unique page-level controls.
- For repeated row buttons, use Playwright/DOM logic scoped to the row containing the exact app name, machine IP, publish order, or container deployment ID.
- Before clicking deployment controls, capture the target row text and button states.
- Never click `批量部署`, `批量回滚`, `确认执行灰度发布`, or any higher-environment control unless the user explicitly asked for that exact action and the corresponding flow is supported.
- If the page says `当前环境：线上` but the version tabs include `预发布/灰度/OA/线上`, use the selected publish tab/API `env` as the deployment environment. Do not infer target environment from the global header alone.

## Full Pre-Release Redeploy Flow

Use this sequence when the user says code changed and asks for a more complete pre-release redeploy:

Default deploy semantics: when the user says `部署`, treat it as "deploy the latest code". Even if an app row currently shows `已发布`, still run branch integration first, then trigger a fresh build, wait for the new artifact, create a new publish order when Lexiao prompts, and deploy from that new artifact. Only skip rebuild/redeploy when the user explicitly asks to check status only, verify only, or not rebuild.

For multiple apps, split the work into two phases: branch integration and build for all target apps first, then ordered deployment. Branch integration runs once. Build all target apps without waiting for earlier publish-order apps; then check all target build results and artifacts together. If any target build fails or remains ambiguous, stop before publish/deploy and diagnose that build. After every target build is `执行成功 / 制作成功`, process publish-order batches; apps with the same `发布顺序` can be deployed and verified concurrently when practical. Pause before the next publish-order batch when deployment fails, evidence is ambiguous, or new ERROR/Exception logs appear in the current batch.

1. Load the Lexiao version page and locate the exact target app row. For multiple apps, extract all target rows and record their `发布顺序`; sorting applies to deployment after the build phase, not to build triggering.
2. Branch integration:
   - Click `分支集成详情` / `分支集成` before build. Do not skip this step.
   - Capture the target project row: project name, branch, last commit, branch status, integration pipeline status, merge status, and CR status.
   - If `批量集成分支` is enabled, click it, confirm, and wait until the target project row is `已合并`, integration pipeline is `执行成功`, and merge status is `合入release成功` or `补丁合入release成功`.
   - If `批量集成分支` is disabled and the target row already shows the success statuses above, report it as "already integrated" and continue.
   - If the target row is not integrated but the button is disabled or missing, stop before build and report the blocker.
3. Build:
   - For one app, click only the target app row's `构建` button and confirm the build dialog.
   - For multiple apps, click each target app row's `构建` button first, without waiting for previous target apps to finish. Then poll the build API for all target apps together.
   - Do this even when the app row currently shows `已发布`, unless the user explicitly says not to rebuild.
   - Build is usually slow; poll `ci_pipeline_status_batch` about every 30 seconds, not high-frequency. Continue until every target `project_id` / `app_id` has `pipeline_status_desc=执行成功` and the pre-release artifact has `artifact_status_desc=制作成功`.
   - Record each target's Jenkins job URL and artifact status. If any build fails, use `jenkins-pipeline-fix` when appropriate, then stop before publish unless the user asked to auto-fix and rebuild.
4. Publish order:
   - Click only the target app row's `部署详情`.
   - If a dialog says `存在新制品，是否要创建新的发布单?`, choose `创建新发布单` after a fresh build unless the user explicitly asks to use the old order.
   - After creating a new order, re-query deployment details and use the new `publish_order_id`; do not keep polling or deploying a stale failed order.
   - Verify the publish order's `version_tag` matches the current target app row before clicking any machine deploy button.
5. Deploy exactly one pre-release target:
   - Prefer one VM/KVM row. Only choose a container target when no VM/KVM exists or the user explicitly asks for container.
   - Click only the selected machine row's `部署` button. Do not click `批量部署`.
   - After this one target is verified, stop and ask whether to continue to the next app or next machine. Do not continue automatically across apps.
6. Verification:
   - Poll Lexiao page/API for the selected machine while checking target-server diagnostics through `java-server-diagnostics`.
   - Treat Lexiao page/API publish status as auxiliary progress only. The deployment health conclusion must come primarily from target-server or container-instance logs observed during the deployment window.
   - Run version-local `stdout.log` checks and shared `error.log` checks in parallel.
7. Error triage and next choices:
   - If deployment or logs show blocking errors, identify the shortest causal chain and propose a concrete fix.
   - If deployment succeeds but deployment-time ERROR/Exception entries remain, classify them as blocking, non-blocking residual, or unrelated based on startup markers, machine run state, and log timing.
   - For multi-app sequences, do not start the next publish-order batch until this classification is complete for every app in the current batch and the batch is judged safe to proceed, or the user confirms continuing despite the residual risk.
   - End with explicit next-step choices when there is actionable code work:
     - `修复问题不提交`: modify code locally and verify, but do not commit/push.
     - `修复问题提交并重新部署`: modify code, verify, commit/push if requested/allowed, then repeat branch integration, build, publish-order creation, deploy, and log checks.
     - `不用下一步`: stop after reporting the current deployment and log evidence.

## Browser Session

Use `get-browser-session` as the session layer. Prefer the existing Lexiao browser tool:

```bash
node /home/joney/projects/ai/agent-tools/skills/common/get-browser-session/scripts/browser_session.js \
  --url=<lexiao-url> \
  --success-text=<target-app-name> \
  --login-pattern='Work Happy|QR Code|Use MOA|Account|登录|扫码|账号|密码|SSO|OAuth'
```

If the default profile under `~/.cache` cannot be locked or written, use a writable profile such as `/home/joney/.codex/lexiao-browser-profile`. If login is required, open a headed browser and ask the user to complete SSO/MOA in the browser; never ask for passwords, OTPs, cookies, or private keys in chat.

## Detailed References

Read these only when the corresponding phase is reached (progressive disclosure):

- `references/scripts.md`: full reusable script catalog (`lexiao_pre_release.js`, `lexiao_project_env.js`, `webshell_log_check.js`) with all actions and flags.
- `references/flows.md`: step-by-step Project Environment Deploy and Pre-Release Single-Machine Deploy flows, Lexiao API endpoints, and outcome rules.
- `references/verification.md`: publish-log markers, startup-time reporting, unit-test/artifact acceptance redlines, and target-server log verification commands.

## Final Report

Keep the final report short and evidence-based:

- What was deployed: app, branch, environment IP/GROUP, publish order.
- Single-machine scope when applicable: state that only one machine was deployed, and whether it was VM/KVM or container.
- Deployment result: page status, publish log markers, PID/port/health check if available.
- Startup time: mandatory for every successful deployment; include publish health-check elapsed time and app initialization duration when available.
- Unit-test result: latest pipeline ID/job URL, pass rate, key coverage metrics, whether it达标.
- Server-log result: checked version-local logs, shared `error.log`, container instance logs when applicable, time window, ERROR/Exception summary, and any residual warnings. Make this the primary health evidence; page status is secondary.
- Error triage: whether errors are blocking or non-blocking, shortest causal chain, and recommended fix when actionable.
- Proceed gate for multi-app deploys: whether it is safe to continue to the next publish-order app, and what evidence supports that decision.
- Next choices when actionable: `修复问题不提交`, `修复问题提交并重新部署`, or `不用下一步`.
- Any blocked checks and the exact reason, especially bastion or login constraints.

## Future Environment Extensions

Add separate sections before operating on higher environments:

- `灰度`: include batch/canary strategy, traffic validation, monitoring windows, and rollback criteria.
- `OA`: include approval gates, OA-specific health checks, and rollback criteria.
- `线上`: include release approval, blast-radius controls, monitoring dashboards, customer-impact checks, and rollback/stop conditions.

Do not infer these flows from project-environment behavior.
