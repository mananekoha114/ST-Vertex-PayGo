import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { editConfig, install, parseArgs, safePath } from '../scripts/install.mjs';
import { normalizeHostAnswer, onlineOptions } from '../scripts/install-online.mjs';

const require = createRequire(import.meta.url);
const yaml = require('yaml');
const yamlRoot = path.dirname(require.resolve('yaml/package.json'));
const front = 'ST-Vertex-PayGo';
const server = 'ST-Vertex-PayGo-Server';
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const json = (p, value) => put(p, JSON.stringify(value));
function copyTree(from, to) {
    if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
    } else fs.copyFileSync(from, to);
}

function fixture(t, name = 'sillytavern', tempRoot = os.tmpdir()) {
    const base = fs.mkdtempSync(path.join(tempRoot, 'paygo installer 测试 '));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const host = path.join(base, 'host with spaces');
    const source = path.join(base, 'source');
    json(path.join(host, 'package.json'), { name, version: name === 'luker' ? '2.7.0' : '1.18.0' });
    for (const file of ['server.js', 'src/plugin-loader.js', 'src/endpoints/google.js']) put(path.join(host, file), '');
    fs.mkdirSync(path.join(host, 'public/scripts/extensions'), { recursive: true });
    copyTree(yamlRoot, path.join(host, 'node_modules/yaml'));
    put(path.join(host, 'config.yaml'), '# keep comment\r\ndataRoot: ./data\r\nenableServerPlugins: false # plugins\r\nlisten: false\r\n');
    json(path.join(source, front, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers', js: 'index.js', css: 'style.css' });
    json(path.join(source, front, 'package.json'), { name: 'st-vertex-paygo', version: '0.4.0' });
    put(path.join(source, front, 'index.js'), '// new frontend');
    put(path.join(source, front, 'style.css'), '');
    json(path.join(source, server, 'package.json'), { name: 'st-vertex-paygo-server', main: 'index.cjs', version: '0.4.0' });
    put(path.join(source, server, 'index.cjs'), '// new server');
    const options = { host, 'local-source': source, branch: 'main' };
    return { base, host, source, options, frontend: path.join(host, 'public/scripts/extensions/third-party', front), backend: path.join(host, 'plugins', server) };
}
const quiet = () => {};

test('CLI rejects removed components, missing values and invalid refs', () => {
    assert.equal(parseArgs(['--host', 'a b', '--dry-run']).host, 'a b');
    for (const args of [['--with-direct-event'], ['--bootstrap'], ['--host'], ['--branch', '../x']]) assert.throws(() => parseArgs(args));
});

test('online options preserve explicit choices and validate environment input', () => {
    assert.deepEqual(parseArgs(['--update']), { update: true });
    assert.equal(onlineOptions(['--update'], {}).branch, undefined);
    assert.equal(onlineOptions(['--update'], { PAYGO_BRANCH: 'release' }).branch, 'release');
    assert.deepEqual(onlineOptions([], { PAYGO_HOST: '/my host', PAYGO_BRANCH: 'feat/bridge', PAYGO_DRY_RUN: '1' }), {
        host: '/my host', branch: 'feat/bridge', 'dry-run': true,
    });
    assert.equal(onlineOptions(['--host', 'explicit', '--branch', 'main'], { PAYGO_HOST: 'ignored', PAYGO_BRANCH: 'ignored' }).host, 'explicit');
    assert.equal(onlineOptions(['--branch', 'main'], { PAYGO_BRANCH: 'ignored' }).branch, 'main');
    assert.throws(() => onlineOptions([], { PAYGO_BRANCH: '../bad' }), /Invalid branch/);
    assert.throws(() => onlineOptions([], { PAYGO_DRY_RUN: 'yes' }), /0 or 1/);
    assert.equal(normalizeHostAnswer('2', ['/first', '/second']), '/second');
    assert.equal(normalizeHostAnswer('"some path"'), path.resolve('some path'));
    assert.throws(() => normalizeHostAnswer(''), /cancelled/);
});

test('online entry auto-detects the current host without reading piped input', t => {
    const f = fixture(t);
    const script = fileURLToPath(new URL('../scripts/install-online.mjs', import.meta.url));
    const env = { ...process.env, PAYGO_DRY_RUN: '1' };
    delete env.PAYGO_HOST;
    const result = spawnSync(process.execPath, [script, '--local-source', f.source], {
        cwd: f.host, encoding: 'utf8', env, input: 'THIS IS NOT A HOST PATH\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(fs.existsSync(f.frontend), false);
});

test('YAML edit preserves comments, CRLF and unrelated semantic values', () => {
    const text = '# hello\r\nenableServerPlugins: false # trailing\r\nlisten: false\r\nnested: { port: 1234 }\r\n';
    const { next } = editConfig(text, yaml);
    assert.match(next, /# hello\r\n/);
    assert.match(next, /true # trailing/);
    assert.deepEqual(yaml.parse(next), { enableServerPlugins: true, listen: false, nested: { port: 1234 } });
    assert.equal(editConfig(next, yaml).next, next);
    assert.throws(() => editConfig('enableServerPlugins: true\nenableServerPlugins: false\n', yaml), /Invalid YAML/);
    assert.throws(() => editConfig('extensions:\n  enabled: false\n', yaml), /extensions.enabled/);
});

test('dry run performs no writes, install copies both components and updates only config setting', t => {
    const f = fixture(t);
    const before = fs.readFileSync(path.join(f.host, 'config.yaml'), 'utf8');
    install({ ...f.options, 'dry-run': true }, quiet);
    assert.equal(fs.existsSync(f.frontend), false);
    assert.equal(fs.existsSync(path.join(f.host, '.paygo-install-backups')), false);
    assert.equal(fs.readFileSync(path.join(f.host, 'config.yaml'), 'utf8'), before);
    put(path.join(f.source, front, '.env'), 'DO_NOT_COPY');
    install(f.options, quiet);
    assert.match(fs.readFileSync(path.join(f.backend, 'index.cjs'), 'utf8'), /new server/);
    assert.equal(fs.existsSync(path.join(f.frontend, '.env')), false);
    assert.equal(yaml.parse(fs.readFileSync(path.join(f.host, 'config.yaml'), 'utf8')).enableServerPlugins, true);
    const backup = path.join(f.host, '.paygo-install-backups', fs.readdirSync(path.join(f.host, '.paygo-install-backups'))[0]);
    assert.equal(fs.readFileSync(path.join(backup, 'config.yaml'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.host, '.paygo-install.lock')), false);
    assert.throws(() => install(f.options, quiet), /replace-modified/);
    put(path.join(f.frontend, 'my-local-change.txt'), 'keep me');
    install({ ...f.options, 'replace-modified': true }, quiet);
    const backups = fs.readdirSync(path.join(f.host, '.paygo-install-backups'));
    assert.ok(backups.some(b => fs.existsSync(path.join(f.host, '.paygo-install-backups', b, front, 'my-local-change.txt'))));
});

test('a config activation failure restores both old plugins and original config', t => {
    const f = fixture(t);
    install(f.options, quiet);
    put(path.join(f.frontend, 'index.js'), '// previous frontend');
    put(path.join(f.backend, 'index.cjs'), '// previous server');
    put(path.join(f.host, 'config.yaml'), 'enableServerPlugins: false\n');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from.endsWith('config.yaml.tmp')) throw new Error('simulated disk failure');
        return rename(from, to);
    };
    try { assert.throws(() => install({ ...f.options, 'replace-modified': true }, quiet), /simulated disk failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(f.frontend, 'index.js'), 'utf8'), '// previous frontend');
    assert.equal(fs.readFileSync(path.join(f.backend, 'index.cjs'), 'utf8'), '// previous server');
    assert.equal(fs.readFileSync(path.join(f.host, 'config.yaml'), 'utf8'), 'enableServerPlugins: false\n');
    assert.equal(fs.existsSync(path.join(f.host, '.paygo-install.lock')), false);
});

test('invalid second payload leaves the first plugin untouched', t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.source, server, 'index.cjs'));
    assert.throws(() => install(f.options, quiet), /entry/);
    assert.equal(fs.existsSync(f.frontend), false);
});

test('user-level renamed PayGo copy blocks a duplicate global installation', t => {
    const f = fixture(t);
    copyTree(path.join(f.source, front), path.join(f.host, 'data/default-user/extensions/old-paygo'));
    assert.throws(() => install(f.options, quiet), /Duplicate ST-Vertex-PayGo/);
});

test('Luker paths come from config and duplicate scans use them', t => {
    const f = fixture(t, 'luker');
    put(path.join(f.host, 'config.yaml'), 'serverPluginsPath: ./custom/server\nglobalExtensionsPath: ./custom/frontend\nenableServerPlugins: false\n');
    install(f.options, quiet);
    assert.ok(fs.existsSync(path.join(f.host, 'custom/server', server, 'index.cjs')));
    assert.ok(fs.existsSync(path.join(f.host, 'custom/frontend', front, 'index.js')));
    fs.renameSync(path.join(f.host, 'custom/frontend', front), path.join(f.host, 'custom/frontend/old-copy'));
    assert.throws(() => install({ ...f.options, 'replace-modified': true }, quiet), /Duplicate/);
});

test('unsupported hosts, versions, escaping paths and concurrent runs are refused', t => {
    const f = fixture(t);
    assert.throws(() => safePath(f.host, path.join(f.host, '../outside')), /Unsafe/);
    assert.throws(() => install({ ...f.options, config: '../outside.yaml' }, quiet), /Unsafe/);
    fs.mkdirSync(path.join(f.host, '.paygo-install.lock'));
    assert.throws(() => install(f.options, quiet), /incomplete installation/);
    fs.rmdirSync(path.join(f.host, '.paygo-install.lock'));
    json(path.join(f.host, 'package.json'), { name: 'tauritavern', version: '9.0.0' });
    assert.throws(() => install(f.options, quiet), /Not a supported/);
    json(path.join(f.host, 'package.json'), { name: 'sillytavern', version: '1.15.9' });
    assert.throws(() => install(f.options, quiet), /requires >=/);
});

test('fresh config is created from host defaults', t => {
    const f = fixture(t);
    fs.renameSync(path.join(f.host, 'config.yaml'), path.join(f.host, 'default-config.yaml'));
    put(path.join(f.host, 'default/config.yaml'), '# defaults\nenableServerPlugins: false\nlisten: false\n');
    install(f.options, quiet);
    assert.equal(yaml.parse(fs.readFileSync(path.join(f.host, 'config.yaml'), 'utf8')).listen, false);
});

test('native launcher forwards paths with spaces from an unrelated working directory', t => {
    const f = fixture(t);
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const args = ['--host', f.host, '--local-source', f.source, '--dry-run'];
    const command = process.platform === 'win32' ? 'powershell.exe' : 'sh';
    const launcherArgs = process.platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repository, 'install.ps1'), ...args]
        : [path.join(repository, 'install.sh'), ...args];
    const result = spawnSync(command, launcherArgs, { cwd: path.dirname(repository), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(fs.existsSync(f.frontend), false);
});

test('managed directory junctions/symlinks are refused', t => {
    const f = fixture(t);
    const outside = path.join(f.base, 'external-plugins');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.host, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => install(f.options, quiet), /Symlink\/junction/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('Git download path works offline and download failure leaves installed files unchanged', t => {
    if (spawnSync('git', ['--version']).status !== 0) return t.skip('Git unavailable');
    const f = fixture(t);
    for (const name of [front, server]) {
        const cwd = path.join(f.source, name);
        for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
    }
    const envKeys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'];
    const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
    process.env.GIT_CONFIG_COUNT = '2';
    for (const [i, name] of [front, server].entries()) {
        process.env[`GIT_CONFIG_KEY_${i}`] = `url.${path.join(f.source, name).replaceAll('\\', '/')}.insteadOf`;
        process.env[`GIT_CONFIG_VALUE_${i}`] = `https://github.com/mananekoha114/${name}.git`;
    }
    try {
        const options = { host: f.host, branch: 'main' };
        install(options, quiet);
        assert.ok(fs.existsSync(path.join(f.frontend, '.git')));
        assert.throws(() => install({ ...options, branch: 'missing-branch' }, quiet), /git clone failed/);
        assert.equal(fs.readFileSync(path.join(f.frontend, 'index.js'), 'utf8'), '// new frontend');
        assert.equal(fs.existsSync(path.join(f.host, '.paygo-install.lock')), false);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

function bootstrapFixture(t) {
    // Git Bash canonicalizes Windows short TEMP paths; keep these fixtures in
    // the workspace so subprocesses share the same permitted absolute root.
    const f = fixture(t, 'sillytavern', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    for (const script of ['install.mjs', 'install-online.mjs']) {
        put(path.join(f.source, front, 'scripts', script), fs.readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8'));
    }
    const env = { ...process.env, PAYGO_HOST: f.host, PAYGO_BRANCH: 'main', PAYGO_INSTALLER_REF: 'main',
        PAYGO_DRY_RUN: '0', PAYGO_REPLACE_MODIFIED: '0',
        HOME: f.base.replaceAll('\\', '/'), PAYGO_TEST_HOME: f.base.replaceAll('\\', '/'), USERPROFILE: f.base, TMP: f.base, TEMP: f.base, GIT_CONFIG_COUNT: '2' };
    delete env.TERMUX_VERSION;
    delete env.PREFIX;
    for (const [i, name] of [front, server].entries()) {
        const cwd = path.join(f.source, name);
        for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) {
            const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
        env[`GIT_CONFIG_KEY_${i}`] = `url.${cwd.replaceAll('\\', '/')}.insteadOf`;
        env[`GIT_CONFIG_VALUE_${i}`] = `https://github.com/mananekoha114/${name}.git`;
    }
    return { ...f, env };
}

function gitAt(cwd, args) {
    const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function withGitMapping(env, action) {
    const keys = Object.keys(env).filter(key => key.startsWith('GIT_CONFIG_'));
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) process.env[key] = env[key];
    try { action(); } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

test('update requires an installed pair and preserves disabled config; failed replacement rolls back', t => {
    const f = fixture(t);
    assert.throws(() => install({ ...f.options, update: true }, quiet), /not installed/);
    install(f.options, quiet);
    const configPath = path.join(f.host, 'config.yaml');
    const disabledConfig = '# preserve exactly\r\nenableServerPlugins: false\r\nextensions:\r\n  enabled: false\r\n';
    put(configPath, disabledConfig);
    put(path.join(f.host, 'data/default-user/settings.json'), '{"keep":"my settings"}');
    const updateOptions = { ...f.options, update: true, 'replace-modified': true };
    put(path.join(f.source, front, 'index.js'), '// updated frontend');
    put(path.join(f.source, server, 'index.cjs'), '// updated server');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from.includes('.paygo-install-stage-') && to === f.backend) throw new Error('simulated second activation failure');
        return rename(from, to);
    };
    try { assert.throws(() => install(updateOptions, quiet), /simulated second activation failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(f.frontend, 'index.js'), 'utf8'), '// new frontend');
    assert.equal(fs.readFileSync(path.join(f.backend, 'index.cjs'), 'utf8'), '// new server');
    assert.equal(fs.readFileSync(configPath, 'utf8'), disabledConfig);
    install(updateOptions, quiet);
    assert.equal(fs.readFileSync(path.join(f.backend, 'index.cjs'), 'utf8'), '// updated server');
    assert.equal(fs.readFileSync(configPath, 'utf8'), disabledConfig);
    assert.equal(fs.readFileSync(path.join(f.host, 'data/default-user/settings.json'), 'utf8'), '{"keep":"my settings"}');
    fs.rmSync(configPath);
    assert.throws(() => install(updateOptions, quiet), /existing host config/);
    assert.equal(fs.existsSync(configPath), false);
});

test('Git update keeps each branch, skips unchanged versions and honors explicit same-commit branch changes', t => {
    const f = bootstrapFixture(t);
    withGitMapping(f.env, () => {
        install({ host: f.host }, quiet);
        gitAt(f.frontend, ['checkout', '-b', 'frontend-release']);
        gitAt(f.backend, ['checkout', '-b', 'server-release']);
        for (const [name, branch, entry] of [[front, 'frontend-release', 'index.js'], [server, 'server-release', 'index.cjs']]) {
            const repository = path.join(f.source, name);
            gitAt(repository, ['checkout', '-b', branch]);
            put(path.join(repository, entry), `// updated ${branch}`);
            gitAt(repository, ['add', entry]);
            gitAt(repository, ['commit', '-m', 'remote update']);
        }
        const configPath = path.join(f.host, 'config.yaml');
        put(configPath, 'enableServerPlugins: false # keep disabled\r\n');
        install({ host: f.host, update: true }, quiet);
        assert.equal(gitAt(f.frontend, ['branch', '--show-current']), 'frontend-release');
        assert.equal(gitAt(f.backend, ['branch', '--show-current']), 'server-release');
        assert.equal(fs.readFileSync(path.join(f.frontend, 'index.js'), 'utf8'), '// updated frontend-release');
        assert.equal(fs.readFileSync(configPath, 'utf8'), 'enableServerPlugins: false # keep disabled\r\n');
        const backupRoot = path.join(f.host, '.paygo-install-backups');
        const beforeBackups = fs.readdirSync(backupRoot);
        const beforeStat = fs.statSync(path.join(f.frontend, 'index.js')).mtimeMs;
        const messages = [];
        install({ host: f.host, update: true }, message => messages.push(message));
        assert.ok(messages.some(message => message.includes('Already up to date')));
        assert.deepEqual(fs.readdirSync(backupRoot), beforeBackups);
        assert.equal(fs.statSync(path.join(f.frontend, 'index.js')).mtimeMs, beforeStat);
        for (const name of [front, server]) gitAt(path.join(f.source, name), ['branch', 'unified-release']);
        install({ host: f.host, update: true, branch: 'unified-release' }, quiet);
        assert.equal(gitAt(f.frontend, ['branch', '--show-current']), 'unified-release');
        assert.equal(gitAt(f.backend, ['branch', '--show-current']), 'unified-release');
    });
});

test('updates reject host data inside a replaced plugin, including linked data paths', t => {
    const f = fixture(t);
    install(f.options, quiet);
    const dataPath = path.join(f.backend, 'state');
    put(path.join(dataPath, 'default-user/settings.json'), 'preserve me');
    const updateOptions = { ...f.options, update: true, 'replace-modified': true };
    put(path.join(f.host, 'config.yaml'), 'dataRoot: ./plugins/ST-Vertex-PayGo-Server/state\nenableServerPlugins: true\n');
    assert.throws(() => install(updateOptions, quiet), /dataRoot must not be inside/);
    fs.symlinkSync(dataPath, path.join(f.host, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
    put(path.join(f.host, 'config.yaml'), 'dataRoot: ./linked-data\nenableServerPlugins: true\n');
    assert.throws(() => install(updateOptions, quiet), /dataRoot must not be inside/);
    assert.equal(fs.readFileSync(path.join(dataPath, 'default-user/settings.json'), 'utf8'), 'preserve me');
});

test('Git update protects dirty files, committed local changes and detached installations', t => {
    const f = bootstrapFixture(t);
    withGitMapping(f.env, () => {
        install({ host: f.host }, quiet);
        const beforeHead = gitAt(f.frontend, ['rev-parse', 'HEAD']);
        put(path.join(f.frontend, 'custom.txt'), 'my untracked customization');
        assert.throws(() => install({ host: f.host, update: true }, quiet), /Local changes/);
        gitAt(f.frontend, ['add', 'custom.txt']);
        gitAt(f.frontend, ['commit', '-m', 'local customization']);
        assert.throws(() => install({ host: f.host, update: true }, quiet), /commits absent/);
        assert.equal(fs.readFileSync(path.join(f.frontend, 'custom.txt'), 'utf8'), 'my untracked customization');
        install({ host: f.host, update: true, 'replace-modified': true }, quiet);
        assert.equal(gitAt(f.frontend, ['rev-parse', 'HEAD']), beforeHead);
        const backupRoot = path.join(f.host, '.paygo-install-backups');
        assert.ok(fs.readdirSync(backupRoot).some(name => fs.existsSync(path.join(backupRoot, name, front, 'custom.txt'))));
        gitAt(f.frontend, ['checkout', '--detach']);
        assert.throws(() => install({ host: f.host, update: true }, quiet), /Cannot infer/);
        install({ host: f.host, update: true, branch: 'main' }, quiet);
        assert.equal(gitAt(f.frontend, ['branch', '--show-current']), 'main');
        assert.throws(() => install({ host: f.host, update: true, branch: 'missing-branch' }, quiet), /git clone failed/);
        assert.equal(gitAt(f.frontend, ['rev-parse', 'HEAD']), beforeHead);
    });
});

for (const mode of ['shell', 'powershell']) {
    test(`${mode} piped commands install and update offline, propagate failures and clean temporary downloads`, t => {
        if (mode === 'powershell' && process.platform !== 'win32') return t.skip('Windows PowerShell test');
        const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'sh';
        if (mode === 'shell' && process.platform === 'win32' && !fs.existsSync(shell)) return t.skip('Git Bash not available');
        if (spawnSync('git', ['--version']).status !== 0) return t.skip('Git unavailable');
        const f = bootstrapFixture(t);
        const content = fs.readFileSync(new URL(`../bootstrap.${mode === 'shell' ? 'sh' : 'ps1'}`, import.meta.url), 'utf8');
        const invoke = (env = f.env, input = content) => {
            const runner = "$installerExit = 77; $ErrorActionPreference = 'Continue'; $download = [Console]::In.ReadToEnd(); try { Invoke-Expression $download } catch { $global:LASTEXITCODE = 1; Write-Output ('BOOTSTRAP_ERROR:' + $_.Exception.Message) }; Write-Output ('SESSION_ALIVE:' + $ErrorActionPreference + ':' + $installerExit); exit $global:LASTEXITCODE";
            return spawnSync(mode === 'shell' ? shell : 'powershell.exe', mode === 'shell' ? ['-c', 'HOME="$PAYGO_TEST_HOME"; export HOME; exec sh -s'] : ['-NoProfile', '-EncodedCommand', Buffer.from(runner, 'utf16le').toString('base64')], {
                cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), env, input, encoding: 'utf8', timeout: 60_000, windowsHide: true,
            });
        };
        const checkCleanup = () => {
            for (const directory of [path.join(f.base, '.cache/paygo-bootstrap'), path.join(f.base, 'paygo-bootstrap')]) {
                if (fs.existsSync(directory)) assert.deepEqual(fs.readdirSync(directory), [], `Unremoved download: ${directory}`);
            }
        };
        const success = invoke();
        assert.equal(success.status, 0, success.stdout + success.stderr);
        assert.match(success.stdout, /Installed successfully/);
        assert.ok(fs.existsSync(path.join(f.backend, 'index.cjs')));
        if (mode === 'powershell') assert.match(success.stdout, /SESSION_ALIVE:Continue:77/);
        checkCleanup();
        const updateContent = fs.readFileSync(new URL(`../update.${mode === 'shell' ? 'sh' : 'ps1'}`, import.meta.url), 'utf8');
        for (const [name, entry] of [[front, 'index.js'], [server, 'index.cjs']]) {
            const repository = path.join(f.source, name);
            put(path.join(repository, entry), '// latest version');
            gitAt(repository, ['add', entry]);
            gitAt(repository, ['commit', '-m', 'publish update']);
        }
        const updated = invoke(f.env, updateContent);
        assert.equal(updated.status, 0, updated.stdout + updated.stderr);
        assert.match(updated.stdout, /Updated successfully/);
        assert.equal(fs.readFileSync(path.join(f.backend, 'index.cjs'), 'utf8'), '// latest version');
        if (mode === 'powershell') assert.match(updated.stdout, /SESSION_ALIVE:Continue:77/);
        checkCleanup();
        const failedClone = invoke({ ...f.env, PAYGO_INSTALLER_REF: 'does-not-exist' });
        assert.notEqual(failedClone.status, 0);
        assert.match(failedClone.stdout + failedClone.stderr, /Unable to download/);
        checkCleanup();
        const failedInstall = invoke({ ...f.env, PAYGO_HOST: path.join(f.base, 'missing host') });
        assert.notEqual(failedInstall.status, 0);
        if (mode === 'powershell') assert.match(failedInstall.stdout, /SESSION_ALIVE:Continue:77/);
        checkCleanup();
        const noHost = invoke({ ...f.env, PAYGO_HOST: '', PAYGO_DRY_RUN: '1' });
        assert.notEqual(noHost.status, 0);
        assert.match(noHost.stdout + noHost.stderr, /No unique host found/);
        checkCleanup();
        // Missing final closure must prevent all side effects, including cloning.
        const truncated = invoke(f.env, content.slice(0, content.lastIndexOf(mode === 'shell' ? ')' : '}')));
        assert.notEqual(truncated.status, 0);
        assert.doesNotMatch(truncated.stdout, /Downloading/);
        checkCleanup();
    });
}
