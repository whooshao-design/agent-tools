# Lexiao Deploy - Verification Details

## Publish Log Verification

Parse the Lexiao `publish_msg` for deploy evidence:

- Version/path mode, entered app directory, current version, restart action.
- Old PID stopped and new PID started.
- Port read from `app_params.json`.
- Health check result and elapsed time.
- `Dubbo run OK!` or equivalent service-ready marker.
- Final publish marker such as `<branch> has publish`.

If publish logs show `项目启动成功` and `Dubbo run OK!`, this is strong deployment evidence, but still perform target-server log verification when access is available.

## Startup Time Reporting

For every successful deployment in any environment, the result must show the service startup time.

- Prefer target-server or container-instance startup logs, such as `init finished, cost=4759ms`, `init for ... duration=4760`, Spring/Dubbo startup elapsed time, or equivalent app-level startup markers.
- Use the Lexiao publish log health-check elapsed time, such as `项目启动成功,result:3,耗时 17 秒`, as fallback or cross-check evidence.
- If both server logs and publish logs expose startup time, report both and label the target-server value as primary.
- If startup time cannot be found after the available log checks, explicitly report `启动耗时：未在发布日志或服务器日志中找到` instead of omitting it.

## Unit Test And Artifact Verification

Open the target row's `流水线详情` and capture the latest task for the target `project_id` / `app_id`.

Required evidence:

- `ci_pipeline_status_batch`: `pipeline_status_desc=执行成功` and artifact status `制作成功`.
- `get_pipeline_task_list_by_version_demand_id`: latest `task_status_desc=执行成功`, `pipeline_task_id`, `job_url`, and unit-test metrics.

Default unit-test acceptance:

- 单测用例通过率 must be 100% unless the Lexiao redline says otherwise.
- 单测增量代码覆盖率 must be at least 90% unless the Lexiao redline says otherwise.
- Report all key metrics: all-line coverage, change-line coverage, change-branch coverage, change-method coverage, change-class coverage.

Do not call unit tests "达标" if the latest pipeline task is not successful, metrics are missing, or the observed metrics are below the applicable redline.

## Target Server Log Verification

Use `java-server-diagnostics` constraints: only inspect the target server through an approved bastion/jump path, and only run read-only diagnostic commands.

Default shared log directory:

```text
/home/product/logs/<app_name>_logs/
```

For VM/KVM deployment, inspect both log locations in parallel:

```text
/home/publish_product/server_java/<app_name>/<version_tag>/logs/
/home/product/logs/<app_name>_logs/error.log
```

For Java apps, startup failures may appear only in the version-local `stdout.log` while `/home/product/logs/<app_name>_logs/error.log` has no new entries. Treat version-local startup logs as primary startup evidence, but always check shared `error.log` concurrently for runtime/application errors.

For container deployment, inspect logs by logging into the instance. Prefer `/home/product/logs/<app_name>_logs/error.log`, `debug.log`, `info.log`, and any available startup/stdout log under the container. Container publish status in Lexiao is not sufficient evidence by itself; use it only to find the active pod, image/version, restart count, and login URL.

For project-environment, stable, test, or prj machines, always use the dev bastion path `dev.ssh.jumpserver.fenqile.cn` for target-server diagnostics. Do not try production bastion first. If the available tool cannot use the dev bastion path, record the server-diagnostics blocker and continue only with non-server evidence; never request the password in chat.

Minimum log checks:

```bash
ls /home/publish_product/server_java/<app_name>/<version_tag>/logs/
tail -240 /home/publish_product/server_java/<app_name>/<version_tag>/logs/stdout.log
grep -n -i 'WARNING\|ERROR\|Exception\|Throwable\|Caused by\|NoSuchBeanDefinitionException\|Dubbo run OK\|项目启动\|has publish' /home/publish_product/server_java/<app_name>/<version_tag>/logs/stdout.log | tail -120
ls /home/product/logs/<app_name>_logs/
tail -200 /home/product/logs/<app_name>_logs/error.log
grep -n -i 'Exception\|ERROR\|Throwable\|Caused by' /home/product/logs/<app_name>_logs/error.log | tail -50
tail -50 /home/product/logs/<app_name>_logs/debug.log
grep -n -i 'Started\|Dubbo\|<app_name>\|ERROR\|Exception\|Throwable\|Caused by' /home/product/logs/<app_name>_logs/debug.log | tail -80
```

Prefer a deployment-time window when possible. Deployment is healthy when the current log continues to refresh after deployment and there is no startup failure, crash loop, Dubbo startup failure, or sustained new exception. Page/API `已发布` is weaker than target-server evidence: if logs show a blocking startup/runtime failure, report the deployment as unhealthy even if the page says `已发布`. Report residual warnings explicitly instead of hiding them; recurring config warnings are not automatically deployment failures unless they block startup or the user task.

For ordered multi-app releases, treat any new deployment-window ERROR/Exception as a sequencing gate. Before continuing to the next app, compare with earlier/historical errors when possible, summarize why it is blocking or non-blocking, and state the proceed/stop decision explicitly.

When using tools that support parallel execution, run the version-local `stdout.log` commands and the shared `error.log` commands at the same time. If the results disagree, trust blocking startup evidence from `stdout.log` for deploy health, and report whether shared `error.log` had deployment-time entries.

When startup fails, summarize the shortest causal chain instead of pasting the whole stack. Example evidence to report:

```text
Spring context initialization failed:
beanA -> beanB
NoSuchBeanDefinitionException: ExampleService
```

When deployment succeeds but `error.log` contains deployment-time errors, classify and summarize them:

- Blocking: Spring context failure, process exit, Dubbo startup failure, health check timeout, crash loop, or the same error prevents the page from reaching `已发布`.
- Non-blocking residual: service starts and keeps running, publish log has ready markers, debug/main logs continue after deployment, and the error is a fallback/provider/config warning not preventing startup.
- Unknown: evidence conflicts or logs stop refreshing. State what is known and what additional check is needed.

For each blocking or unknown issue, provide a concise root-cause hypothesis, suggested code/config fix, and the next-step choices from `Full Pre-Release Redeploy Flow`.

