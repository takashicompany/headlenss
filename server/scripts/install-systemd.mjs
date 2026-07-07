#!/usr/bin/env node
// Install a systemd --user service for the headlenss server.
// Idempotent — safe to re-run.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(__dirname, 'headlenss.service.template');
const USER_SYSTEMD_DIR = resolve(homedir(), '.config/systemd/user');

// Support --name for test units (e.g. --name headlenss-test)
const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const UNIT_NAME = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : 'headlenss';
const UNIT_PATH = resolve(USER_SYSTEMD_DIR, `${UNIT_NAME}.service`);

function step(msg) {
  console.log(`\n==> ${msg}`);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

function tryRun(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')} (ignore failure)`);
  spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

if (process.platform !== 'linux') {
  console.error('this installer targets Linux + systemd only.');
  console.error('on macOS, you can either:');
  console.error('  - run inside tmux:  tmux new-session -d -s headlenss-server "cd ' + SERVER_DIR + ' && npm start"');
  console.error('  - write a launchd plist (~/Library/LaunchAgents/) — out of scope here');
  process.exit(1);
}

step('checking systemd --user availability');
const systemctl = which('systemctl');
if (!systemctl) {
  console.error('  systemctl not found. is this a systemd-based system?');
  process.exit(1);
}
try {
  execSync('systemctl --user show-environment >/dev/null 2>&1');
  console.log('  systemd --user is reachable');
} catch {
  console.error('  systemd --user is not reachable. ensure your session has DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR set,');
  console.error('  or that you are using a systemd-managed login. you can also try:');
  console.error('    loginctl enable-linger $USER  (requires sudo)');
  console.error('  and re-run from a fresh shell.');
  process.exit(1);
}

step('resolving paths');
const nodePath = process.execPath;
console.log(`  node: ${nodePath}`);

// Resolve npm's CLI entry point (the .js file, not the shell wrapper) so
// ExecStartPre can call it via the absolute node path.
const npmBin = which('npm') ?? 'npm';
let npmCliPath = npmBin;
try {
  // npm's bin wrapper is usually a shell script; resolve the real JS entry via realpath
  const r = spawnSync('realpath', [npmBin], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    npmCliPath = r.stdout.trim();
  }
} catch { /* keep npmBin */ }
console.log(`  npm cli: ${npmCliPath}`);

const defaultPort = process.env.PORT ?? '3000';
console.log(`  port: ${defaultPort}`);

step('rendering unit file');
const template = readFileSync(TEMPLATE_PATH, 'utf8');
const unit = template
  .replaceAll('{{SERVER_DIR}}', SERVER_DIR)
  .replaceAll('{{NODE}}', nodePath)
  .replaceAll('{{NPM_CLI}}', npmCliPath)
  .replaceAll('{{PORT}}', defaultPort)
  .replaceAll('{{PATH}}', process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');

mkdirSync(USER_SYSTEMD_DIR, { recursive: true });
writeFileSync(UNIT_PATH, unit);
console.log(`  wrote: ${UNIT_PATH}`);

step('reloading systemd and enabling unit');
run(systemctl, ['--user', 'daemon-reload']);
run(systemctl, ['--user', 'enable', `${UNIT_NAME}.service`]);

step('starting service');
try {
  // Stop first (ignore failure if not running), then start.
  // This avoids the old npm-wrapper issue where `restart` sends SIGTERM to npm
  // but the node server keeps holding the port.
  tryRun(systemctl, ['--user', 'stop', `${UNIT_NAME}.service`]);
  run(systemctl, ['--user', 'start', `${UNIT_NAME}.service`]);
} catch {
  console.error('\nstart failed. check logs:');
  console.error(`  journalctl --user -u ${UNIT_NAME} -n 50 --no-pager`);
  process.exit(1);
}

step('done');
console.log(`  service ${UNIT_NAME} installed, enabled, and started.`);
console.log('\nuseful commands:');
console.log(`  npm run service:status     # systemctl --user status ${UNIT_NAME}`);
console.log(`  npm run service:logs       # journalctl --user -u ${UNIT_NAME} -f`);
console.log(`  systemctl --user restart ${UNIT_NAME}`);
console.log(`  systemctl --user stop ${UNIT_NAME}`);
console.log(`  systemctl --user disable ${UNIT_NAME}`);

const lingerPath = `/var/lib/systemd/linger/${process.env.USER ?? ''}`;
if (process.env.USER && !existsSync(lingerPath)) {
  console.log('\nNOTE: to keep the service running after you log out / on reboot,');
  console.log('enable user-linger ONCE (requires sudo):');
  console.log(`  sudo loginctl enable-linger ${process.env.USER}`);
} else if (existsSync(lingerPath)) {
  console.log('\nlinger already enabled — service will survive logout & reboot.');
}
