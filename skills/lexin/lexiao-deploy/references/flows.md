# Lexiao Deploy - Detailed Flows

## Project Environment Deploy

Prefer the fixed project-environment script over ad hoc Playwright snippets:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=status \
  --url=<lexiao-related-demand-url> \
  --app=<app-name> \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/main

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=deploy \
  --url=<lexiao-related-demand-url> \
  --app=<app-name> \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/main \
  --build-timeout=1200000 \
  --deploy-timeout=1200000
```

Use `status` first to verify the script selected the exact app row. If the row is already `执行成功 / 制作成功 / 已发布` and the deploy button is disabled, report that there is no pending deployable artifact instead of clicking build or deploy. If the row is `执行中` or `制作中`, wait; if the deploy button becomes clickable with a red dot, `deploy` clicks only that row's `部署` button and confirms the one-click deployment dialog.

1. Load the Lexiao page and locate the exact target app row.
2. Treat a clickable `部署` button as a pending deployable artifact. Treat a disabled `部署` button as no deployable artifact unless the user explicitly says otherwise.
3. Before clicking, capture the row text and button states.
4. Click only the target row's `部署` button.
5. Confirm only if the dialog clearly asks for one-click deployment, e.g. `请确认是否进行一键部署操作?`.
6. Capture the immediate page/message feedback, such as `发布正在执行中...`.
7. Poll page state and Lexiao publish-status responses until one of these outcomes:
   - Success: target row is `已发布`, deploy button is disabled, red dot is gone, and API status is `PUBLISHED` or `need_show_deploy_red_dot=false`.
   - Failure: page/API reports failure, timeout, or rollback requirement.
   - Ambiguous: no stable status within the expected deploy window; report what was observed and keep checking only if requested.

Record `publish_order_id`, `version_publish_detail_id`, `publish_status_desc`, `publish_status`, and `publish_msg`.

## Pre-Release Single-Machine Deploy

Use this flow only for `预发布` and only for one machine unless the user explicitly asks otherwise. If the user says "部署机器" without choosing VM or container, prefer VM/KVM.

1. Load the Lexiao version page and locate the exact target app row.
2. Confirm build/artifact readiness from the row and `ci_pipeline_status_batch`:
   - pipeline status should be `执行成功`;
   - pre-release artifact status should be `制作成功`;
   - app row should show a deployable status such as `已打包`, `待推送`, or a recoverable `发布失败`.
3. Open only the target app row's `部署详情`.
4. If Lexiao prompts `存在新制品，是否要创建新的发布单?`, choose the correct order path:
   - after a fresh build, choose `创建新发布单` by default;
   - only choose `使用旧发布单` when the user explicitly requests it or no new artifact should be deployed;
   - after choosing, re-query deployment details and use the active/new `publish_order_id`.
5. Capture `publish_order_id`, `version_publish_detail_id`, `app_id`, `version_tag`, deployment type, and all visible deployment targets.
6. Select exactly one target:
   - If the user specified an IP, match that IP exactly.
   - Otherwise choose one VM/KVM row first, usually a row with `待推送`, `发布失败`, or another deployable status.
   - Only if no VM/KVM row exists, choose one container target.
   - For mixed deployment apps, do not deploy container nodes just because the page warns `预发布环境存在容器节点请请勿遗漏` when the user asked to deploy only one machine.
   - For multi-app requests, this one target completes the current app's default deployment scope. Verify it before marking that app done. Apps in the same publish-order batch can run in parallel; later publish-order batches must wait for current-batch log verification.
7. Click only the selected machine row's `部署` button. Do not click `批量部署`.
8. Confirm only if the visible dialog clearly confirms deployment for the selected pre-release target. Record the confirmation text.
9. Immediately start two checks in parallel:
   - Poll Lexiao page/API status for the selected machine as auxiliary progress.
   - Inspect the selected server through `java-server-diagnostics` read-only commands. Within log inspection, query version-local `logs/stdout.log` and shared `/home/product/logs/<app_name>_logs/error.log` in parallel; do not wait for one before checking the other.
   - For container deployments, use the page/API `login_pod_addr` or the visible `登录实例` entry to open the pod shell, then run read-only `ls`/`tail`/`grep` checks inside the instance. Do not conclude from container page status alone.

Useful Lexiao APIs observed on pre-release pages:

```text
GET /oa/publish/devops/deploymentOrder/getPublishDetails.json?version_id=<version_id>&order_id=<publish_order_id>&env=pre&app_type=java
GET /oa/publish/devops/deploymentOrder/getKVMPublishProgress.json?order_id=<publish_order_id>&env=pre
GET /oa/publish/devops/deploymentOrder/getPublishProgress.json?order_id=<publish_order_id>&env=pre
POST /oa/lexiao/get_version_publish_status.json
```

For VM/KVM, record from the selected machine row/API:

- `machine_ip`, `set`, `machine_status`
- `publish_status`, `publish_status_desc`, `publish_msg`, `publish_time`
- `pushed_num`, `published_num`, `roll_backed_num`, `total_replicas`

Pre-release outcome rules:

- Success: selected machine is published (`PUBLISHED`/`已发布` or equivalent), machine is running when the page exposes run state, and logs show startup success without new blocking errors.
- Failure: page/API reports `PUBLISH_FAIL`/`发布失败`, machine remains `STOP`, `publish_msg` reports timeout/failure, or version logs show Spring/Dubbo startup failure.
- Ambiguous: page/API is still running but logs show progress; report the latest page status and log evidence, then continue only if requested.
- Do not classify a publish as failed only because the publish log contains an old-stop message such as `ERROR: The <app> does not started!`; if the same publish log later shows `项目启动成功`, `Dubbo run OK!`, final `<version> has publish`, and the machine is `RUNNING/已发布`, treat the deploy itself as successful and report the old-stop line as non-blocking publish noise.

## Gray / All-Target Scheduling

Use this flow when the user explicitly asks for `灰度` deployment or asks to deploy all gray machines/targets. Gray skips branch integration and build unless the user says otherwise.

1. List target applications and record `发布顺序`.
2. Process publish-order batches from smallest to largest.
3. For applications in the same `发布顺序` batch, concurrent deployment is allowed:
   - Prefer one subagent per application when subagent delegation is allowed by the active tool policy.
   - Each subagent or local worker owns exactly one app/order. Do not let two workers operate the same app's VM/KVM list.
   - Independent status and log checks for different apps in the same batch may run in parallel.
4. Within one application, split targets into lanes after opening the publish order:
   - VM/KVM lane: deploy one `machine_ip` at a time. Wait for that machine's publish status and log-first verification/classification before starting the next VM/KVM machine for the same app.
   - Container lane: deploy exact container `order_detail_id` / `deployment_id` targets together or in parallel. Prefer a scoped API call with all exact `order_detail_ids` over repeated UI clicks. Do not click a generic UI `批量部署` button.
   - VM/KVM lane and container lane may run concurrently for the same app, but the app is healthy only after both lanes finish and logs are verified or residual errors are classified.
5. Do not start a later publish-order batch until every app in the current batch has completed all requested VM/KVM and container lanes and passed the sequential publish gate.
6. If any VM/KVM machine or container target fails, becomes ambiguous, or shows new deployment-window ERROR/Exception logs, pause that app's remaining undeployed targets until the error is classified as blocking, non-blocking, or unrelated. Continue later targets only when the classification supports it or the user accepts the risk.
