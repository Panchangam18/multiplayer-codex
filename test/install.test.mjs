import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve('install.sh');
const checksum = readFileSync(installer, 'utf8').match(/local checksum="([a-f0-9]{64})"/)[1];
const macTest = (name, run) => test(name, { skip: process.platform !== 'darwin' }, run);

function appFixture(path, version = '0.3.0', identifier = 'com.multiplayer-codex.companion') {
  mkdirSync(join(path, 'Contents'), { recursive: true });
  writeFileSync(join(path, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
}

function fixture(context) {
  const home = mkdtempSync(join(tmpdir(), 'multiplayer-installer-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, 'Applications/Multiplayer Codex.app');
  const bundle = join(home, 'fixture.app');
  appFixture(bundle);
  const bootstrap = join(home, 'mock-commands.sh');
  writeFileSync(bootstrap, `
uname() { if [[ "$1" == -s ]]; then echo "\${TEST_OS:-Darwin}"; else echo "\${TEST_ARCH:-arm64}"; fi; }
sw_vers() { echo "\${TEST_MACOS:-14.0}"; }
id() { echo "\${TEST_UID:-501}"; }
curl() {
  printf 'download\\n' >> "$HOME/actions"
  [[ "\${TEST_DOWNLOAD_FAIL:-0}" != 1 ]] || return 22
  local output
  while (( $# )); do if [[ "$1" == -o ]]; then output="$2"; shift; fi; shift; done
  printf 'fixture archive' > "$output"
}
shasum() { printf '%s  archive\\n' "\${TEST_CHECKSUM:-${checksum}}"; }
ditto() {
  printf 'extract\\n' >> "$HOME/actions"
  mkdir -p "$4"
  /bin/cp -R "$HOME/fixture.app" "$4/Multiplayer Codex.app"
}
codesign() { [[ "\${TEST_SIGNATURE_FAIL:-0}" != 1 ]]; }
pgrep() { [[ "\${TEST_RUNNING:-0}" == 1 ]]; }
open() { printf 'open\\n' >> "$HOME/actions"; }
mv() {
  if [[ "\${TEST_MOVE_FAIL:-0}" == 1 && "$1" == */unpacked/* ]]; then return 1; fi
  /bin/mv "$@"
}
`);
  return {
    home, destination, bundle,
    run: (environment = {}, args = ['--no-open']) => spawnSync('/bin/bash', [installer, ...args], {
      env: { ...process.env, HOME: home, BASH_ENV: bootstrap, ...environment }, encoding: 'utf8', timeout: 10000,
    }),
    actions: () => existsSync(join(home, 'actions')) ? readFileSync(join(home, 'actions'), 'utf8') : '',
    stages: () => existsSync(join(home, 'Applications')) ? readdirSync(join(home, 'Applications')).filter(name => name.startsWith('.multiplayer-install.')) : [],
  };
}

macTest('installer installs, cleans staging, and skips opening when requested', context => {
  const setup = fixture(context);
  const result = setup.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(setup.destination, 'Contents/Info.plist')));
  assert.equal(setup.actions(), 'download\nextract\n');
  assert.deepEqual(setup.stages(), []);
});

macTest('installer defaults to launching and reruns without downloading again', context => {
  const setup = fixture(context);
  assert.equal(setup.run({}, []).status, 0);
  const result = setup.run({}, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/);
  assert.equal(setup.actions(), 'download\nextract\nopen\nopen\n');
});

macTest('installer rejects unsupported platforms, old macOS, and sudo before download', context => {
  const setup = fixture(context);
  for (const environment of [{ TEST_OS: 'Linux' }, { TEST_ARCH: 'x86_64' }, { TEST_MACOS: '13.6' }, { TEST_UID: '0' }]) {
    assert.notEqual(setup.run(environment).status, 0);
  }
  assert.equal(setup.actions(), '');
});

macTest('installer fails closed on bad downloads and cleans temporary files', context => {
  const setup = fixture(context);
  for (const environment of [{ TEST_DOWNLOAD_FAIL: '1' }, { TEST_CHECKSUM: 'bad' }, { TEST_SIGNATURE_FAIL: '1' }]) {
    const result = setup.run(environment);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(existsSync(setup.destination), false);
    assert.deepEqual(setup.stages(), []);
    assert.doesNotMatch(result.stderr, /unbound variable/);
  }
});

macTest('installer rejects a downloaded app with unexpected identity or version', context => {
  const setup = fixture(context);
  for (const [version, identifier] of [['0.3.0', 'unrelated.app'], ['99.0.0', 'com.multiplayer-codex.companion']]) {
    appFixture(setup.bundle, version, identifier);
    const result = setup.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected app identity or version/);
    assert.equal(existsSync(setup.destination), false);
    assert.deepEqual(setup.stages(), []);
  }
});

macTest('installer refuses unrelated destinations and symlinks', context => {
  const setup = fixture(context);
  appFixture(setup.destination, '0.3.0', 'unrelated.app');
  assert.match(setup.run().stderr, /unrelated app/);
  rmSync(setup.destination, { recursive: true });
  symlinkSync(setup.bundle, setup.destination);
  assert.match(setup.run().stderr, /symlink/);
  assert.equal(setup.actions(), '');
});

macTest('installer preserves the old version and user state on upgrade', context => {
  const setup = fixture(context);
  appFixture(setup.destination, '0.2.0');
  writeFileSync(join(setup.home, 'user-state'), 'preserve');
  const result = setup.run();
  assert.equal(result.status, 0, result.stderr);
  const backup = readdirSync(join(setup.home, 'Applications')).find(name => name.startsWith('.multiplayer-backup.'));
  assert.ok(backup);
  assert.match(readFileSync(join(setup.home, 'Applications', backup, 'Multiplayer Codex.app/Contents/Info.plist'), 'utf8'), /0\.2\.0/);
  assert.equal(readFileSync(join(setup.home, 'user-state'), 'utf8'), 'preserve');
});

macTest('installer refuses to replace a running older companion', context => {
  const setup = fixture(context);
  appFixture(setup.destination, '0.2.0');
  const result = setup.run({ TEST_RUNNING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Quit Multiplayer Codex/);
  assert.equal(setup.actions(), '');
});

macTest('installer restores the previous app if final placement fails', context => {
  const setup = fixture(context);
  appFixture(setup.destination, '0.2.0');
  const result = setup.run({ TEST_MOVE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous app was restored/);
  assert.match(readFileSync(join(setup.destination, 'Contents/Info.plist'), 'utf8'), /0\.2\.0/);
  assert.deepEqual(setup.stages(), []);
});

macTest('installer help does not modify the machine', context => {
  const setup = fixture(context);
  assert.equal(setup.run({}, ['--help']).status, 0);
  assert.notEqual(setup.run({}, ['--unknown']).status, 0);
  assert.equal(setup.actions(), '');
});
