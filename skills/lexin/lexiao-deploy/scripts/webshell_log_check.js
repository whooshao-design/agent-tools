#!/usr/bin/env node
const { spawnSync } = require('child_process');

const target = '/home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js';
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.stack || result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
