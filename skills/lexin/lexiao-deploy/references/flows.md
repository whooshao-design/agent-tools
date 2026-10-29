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

Add `--cluster=<cluster-id-or-set>` to `deploy` when the dialog lists more than one `待发布` cluster row. MCP equivalents: `lexiao_project_status(url, app)` and `lexiao_project_deploy(url, app, cluster=...)`.

### Build check before deploy

A git push to the demand branch auto-triggers `feature-pipeline-<project>-<branch>`, so a code change normally needs only a deploy. A dependency jar republished to Nexus without a code push does not trigger a build, and the deployed artifact keeps the old jar until someone clicks the row's `构建`. Decide with the read-only MCP tool before touching `构建` (the row's `need_build` / `need_show_build_red_dot` fields were observed as `true` / `false` on an already-built row on 2026-10-28 and are not used):

```text
lexiao_project_build_check(repo_dir=<local repo>, app=<Lexiao app name>, branch=<demand branch, default current>, jars=<group:artifact:version,...>)
```

- `app` is the Lexiao app name, not the repo name: the job is `feature-pipeline-<app>-<branch>` (repo `process-engine-java` → job `feature-pipeline-process-engine-rel_processOwnerAlert_1426731`). A build whose `BuildData` has no commit for this repo returns `unknown`.
- It reads the pipeline's last Jenkins build (`number`, `building`, `result`, `timestamp`, and the built commit from the `BuildData` whose `remoteUrls` point at this repo), runs `git fetch origin <branch>` to get the remote HEAD and its commit time, and reads `lastUpdated` from each jar's `maven-metadata.xml` under `http://product.fenqile.com:8081/nexus/content/repositories/snapshots/`.
- Pass in `jars` every SNAPSHOT coordinate this demand republished (from `upload-lexiao-nexus-jar` records or the user); the tool does not discover them from the pom. Without `jars` it only checks the code.
- `decision`:
  - `deploy-only`: the last build succeeded on the remote HEAD and every listed jar was updated before that build started → run `deploy` without building.
  - `build`: the last build is not the remote HEAD (and the HEAD commit is older than 10 minutes), the last build failed, or a listed jar was updated after the build started → run `lexiao_project_env.js --action=build` (MCP `lexiao_project_build`), then deploy. Do not hand-write a click script: a substring row match once clicked `process-engine`'s `构建` when `process-engine-simulate` was meant.

`build` flow (`--build-timeout` default 1200000, `--poll-ms` default 30000, `--start-timeout` default 180000):

1. Load the page, capture `ci_pipeline_status_batch.json`, and take this app's pipeline by the exact job name `feature-pipeline-<app>-<branch>` from `pipeline_job_url` (the branch comes from the row's `<branch> 研发: <account>` cell). The result rows have no app-name field, and apps share prefixes, so never match by prefix.
2. Row already `执行中`/`制作中` → `already-building`, no click.
3. Click only that row's `构建`. Confirm only a box whose text mentions 构建 and contains no 回滚/灰度/批量/线上 (observed: `请确认是否进行构建操作?`).
4. Reload every `--poll-ms` until the Jenkins build number in `pipeline_job_url` is larger than before and `pipeline_status_desc=执行成功` with the `prj` artifact `制作成功` (`success`), or the status contains 失败/异常/中止 (`failed`). No new build number within `--start-timeout` → `not-triggered`.

App rows are matched in both `status`, `deploy` and `build` by a direct `td` cell equal to the app name inside the page's `el-table` body rows (buttons of the right fixed column of the same row are included); zero matches → `row-not-found`, more than one → `row-ambiguous`.
  - `wait`: a build is running, or the remote HEAD is unbuilt but committed within 10 minutes (the auto-build may still be queued) → re-run the check after it settles.
  - `unknown`: Jenkins, git or a jar's metadata could not be read → report `reasons` and do not guess.
- The 10-minute window uses the commit time, not the push time; a commit pushed long after it was made can show `build` while its auto-build is still queued. Re-run the check once before building when the push was just made.

Since the 2026-10 Lexiao change, a git push auto-builds a new project-environment artifact, and the app row no longer gets a `部署` button. Instead the row's `部署详情` button shows a red dot (the script reports it as `redDot`; `get_version_publish_status.json` also returns a per-app `need_show_deploy_red_dot`, reported but not relied on), and the deploy entry is the `发布` button on a cluster row inside that dialog. The script supports both UIs: a clickable row-level `部署` button still takes the old path.

`status` (read-only apart from what the page itself does) waits for the app row to render, then opens the row's `部署详情` and reports:

- `row`: row text and buttons, each with `disabled` and `redDot`.
- `dialog`: `version_tag`, `published` / `rolled_back` (`已发布机器数` / `已回滚机器数`), `clusters[]` (`status`, `set`, `cluster`, `room`, `replicas`, `publish_time`, `buttons`), `pods[]` (`name`, `ip`, `version`, `state`, `age`), and `deployable` (a `待发布` cluster row exists).
- `publish_order`: `order_id` (from `create_publish_order.json` when the page created one, else the `order_id` of the page's `getPublishDetails.json` request, else the row's `publish_order_id`), `demand_id`, and `row_publish_status`.
- `api`: `getPublishDetails.json` cluster details (`order_detail_id`, `deployment_id`, `namespace`, `publish_status`, `publish_status_desc`) and `getPublishProgress.json` pods with `restart_count`.

Opening the dialog makes the page call `create_publish_order.json` when there is a new artifact; the normal UI does the same, so this is acceptable for `status`.

`deploy` flow:

1. Reload the page and poll until the exact app row renders. Right after page load the row may be missing; clicking too early returns `row-not-found`.
2. Row text with `失败`/`异常` → `failed`. A clickable row `部署` button → legacy path: click it, confirm the one-click deployment dialog, and poll the row until `已发布`.
3. Row still building (`执行中`/`制作中`) → wait and reload.
4. Otherwise click the row's `部署详情` and read the dialog. Pick the single `待发布` cluster row (filtered by `--cluster` when given). More than one without a filter → `cluster-ambiguous` (no click); filter matches nothing → `cluster-not-found`; no `发布` button or it is disabled → `publish-button-unavailable`.
5. No `待发布` row while the row is `执行成功 / 制作成功` → `no-deployable-artifact` (exit code 2). Do not click `构建` to work around it unless the user asked to rebuild or `lexiao_project_build_check` returns `build`.
6. Click only that cluster row's `发布` (exact text). Never click `构建`, `回滚`, `批量推送`, `同步制品`, or `确认执行灰度发布`.
7. Lexiao observed on 2026-10-28 starts the rolling deploy immediately without a confirm box. If a confirm box appears, the script confirms it only when its text is about 发布/部署 and contains no 回滚/灰度/批量; otherwise it stops with `unexpected-dialog-*` and does not click.
8. Poll `getPublishDetails.json?version_id=0&order_id=<order_id>&env=prj&app_type=java&demand_id=<demand_id>` and `getPublishProgress.json?order_id=<order_id>&env=prj` from the page context every `--poll-ms` (default 10000):
   - Success: the target cluster's `publish_status_desc=已发布` (`publish_status` becomes `ROLL_INIT`) and `published_num == total_replicas` (dialog shows `已发布机器数：(1/1)`).
   - Failure: `publish_status_desc`/`publish_msg` contains `失败`/`已回滚`/`回滚中`, or `publish_status` contains `FAIL`.
   - While rolling (`发布中 … 滚动发布中`) the new pod may show `FAILED` for the first seconds and then `RUNNING`; this is not a failure.
   - Timeout after `--deploy-timeout`; observed deploys took about 3-15 minutes.

Record `order_id`, `order_detail_id`, `deployment_id`, `version_tag`, `publish_status_desc`, `publish_status`, and the final pods (`login_pod_addr` is in `done.result.pods[]` for container log checks).

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
   - VM/KVM lane first, container lane after: start container targets only when every VM/KVM target of the app is published and verified (SKILL.md rule; never run the two lanes concurrently). The app is healthy only after both lanes finish and logs are verified or residual errors are classified.
5. Do not start a later publish-order batch until every app in the current batch has completed all requested VM/KVM and container lanes and passed the sequential publish gate.
6. If any VM/KVM machine or container target fails, becomes ambiguous, or shows new deployment-window ERROR/Exception logs, pause that app's remaining undeployed targets until the error is classified as blocking, non-blocking, or unrelated. Continue later targets only when the classification supports it or the user accepts the risk.
