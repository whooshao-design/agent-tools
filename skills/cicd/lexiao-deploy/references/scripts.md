# Lexiao Deploy - Script Catalog

## Reusable Scripts

Use the bundled scripts for repeated Lexiao operations. Do not recreate temporary Playwright scripts for common tasks; if a new operation needs custom automation, add it to these scripts after the run.

Common commands:

```bash
node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=status \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=deploy \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=list-apps \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=branch-integrate \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build \
  --url=<lexiao-url> \
  --app=<app-name> \
  --app-id=<app-id> \
  --project-id=<project-id>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=wait-build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2> \
  --poll-ms=30000

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=open-order \
  --url=<lexiao-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=deploy-one \
  --url=<lexiao-url> \
  --app=<app-name> \
  --order-id=<publish-order-id> \
  --target-type=auto
```

For gray deployment, add `--env=gray`; gray skips branch integration and build, but still uses `list-apps`, `open-order`, `deploy-one`, and log verification.

For container instance logs, use the fixed webshell helper instead of writing a new script:

```bash
node /home/joney/projects/ai/agent-tools/skills/cicd/lexiao-deploy/scripts/webshell_log_check.js \
  --url=<login_pod_addr> \
  --app=<log-app-name>
```

`lexiao_pre_release.js --action=deploy-one` deploys one target only. It chooses VM/KVM first when `--target-type=auto`; use `--target-ip=<ip>` to pin a VM or `--target-type=container --deployment-id=<id>` for a container target.

