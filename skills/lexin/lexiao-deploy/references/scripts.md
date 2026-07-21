# Lexiao Deploy - Script Catalog

## Reusable Scripts

Use the bundled scripts for repeated Lexiao operations. Do not recreate temporary Playwright scripts for common tasks; if a new operation needs custom automation, add it to these scripts after the run.

Common commands:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=status \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=deploy \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=list-apps \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=branch-integrate \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build \
  --url=<lexiao-url> \
  --app=<app-name> \
  --app-id=<app-id> \
  --project-id=<project-id>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=wait-build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2> \
  --poll-ms=30000

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=open-order \
  --url=<lexiao-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=deploy-one \
  --url=<lexiao-url> \
  --app=<app-name> \
  --order-id=<publish-order-id> \
  --target-type=auto
```

For gray deployment, add `--env=gray`; gray skips branch integration and build, but still uses `list-apps`, `open-order`, `deploy-one`, and log verification.

For container instance logs during deployment verification, call the diagnostics-owned helper instead of writing a new script:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \
  --app=<log-app-name> \
  --env=pre \
  --lines=120
```

If a deployment flow already has a `login_pod_addr`, use `/home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js` directly. The old `lexiao-deploy/scripts/webshell_log_check.js` path is only a compatibility wrapper.

`lexiao_pre_release.js --action=deploy-one` deploys one target only. It chooses VM/KVM first when `--target-type=auto`; use `--target-ip=<ip>` to pin a VM or `--target-type=container --deployment-id=<id>` for one container target.

For all-target gray deployment orchestration:

- Run one app-owned deployment lane per target application. Apps with the same `发布顺序` may run in parallel, preferably one subagent per app when the active tool policy allows subagent delegation.
- In each app-owned lane, call `deploy-one` for VM/KVM targets one `--target-ip` at a time and wait for publish/log verification before the next VM/KVM.
- Container targets for the same app may be triggered together or in parallel after exact `order_detail_id` / `deployment_id` values are captured. Prefer the Lexiao API `publish_by_order_detail_id.json` with exact `order_detail_ids` when deploying multiple containers; do not click the generic UI `批量部署` button.
