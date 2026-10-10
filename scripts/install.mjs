#!/usr/bin/env node
// Shared installer for Windows, macOS, Linux, WSL and Termux. No npm install here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HELP = `PayGo suite installer (Node.js >= 20)
Usage: node scripts/install.mjs --host <SillyTavern-or-Luker-directory> [options]

  --host PATH             Existing, stopped SillyTavern >=1.16 / Luker >=2.7
  --update                Update an existing pair; preserve config and branches
  --branch NAME           Both component refs (install: main; update: keep each)
  --mode tag|commit       main defaults to tag; other branches default to commit
  --tag NAME              Select a specific tag in both repos (default: latest)
  --frontend-commit SHA   Exact frontend commit (requires --server-commit)
  --server-commit SHA     Exact server commit (requires --frontend-commit)
  --local-source PATH     Offline source directory containing ST-Vertex-PayGo
                          and ST-Vertex-PayGo-Server (copies current files)
  --config PATH           Host config file (relative to host; default config.yaml)
  --data-root PATH        Actual host data root, if overridden at startup
  --plugins-path PATH     Luker serverPluginsPath override (inside host)
  --extensions-path PATH  Luker globalExtensionsPath override (inside host)
  --replace-modified      Replace locally modified/unmanaged installs WITH backup
  --dry-run              Validate paths/config and show plan without writes/network
  --help, -h             Show help

Installs frontend globally for all host users. Close the host before running.
Existing plugins and config are backed up under <host>/.paygo-install-backups/.
No Google credentials, host source, or other plugins are configured.
Only existing SillyTavern and Luker hosts are supported.
`;

const FRONTEND = 'ST-Vertex-PayGo';
const SERVER = 'ST-Vertex-PayGo-Server';
const remote = name => `https://github.com/mananekoha114/${name}.git`;
const exists = p => fs.existsSync(p);
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const fail = message => { throw new Error(message); };

export function parseArgs(args) {
    const result = {};
    const values = new Set(['host', 'branch', 'mode', 'tag', 'frontend-commit', 'server-commit', 'local-source', 'config', 'data-root', 'plugins-path', 'extensions-path']);
    const flags = new Set(['replace-modified', 'dry-run', 'update']);
    for (let i = 0; i < args.length; i++) {
        const key = args[i].replace(/^--/, '');
        if (args[i] === '--help' || args[i] === '-h') result.help = true;
        else if (args[i].startsWith('--') && values.has(key)) {
            if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`Missing value: --${key}`);
            result[key] = args[++i];
        } else if (args[i].startsWith('--') && flags.has(key)) result[key] = true;
        else fail(`Unknown argument: ${args[i]} (use --help)`);
    }
    if (!result.branch && !result.update) result.branch = 'main';
    validateOptions(result);
    return result;
}

function validateRef(ref) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) fail('Invalid branch/tag name.');
}

export function validateOptions(options) {
    for (const ref of [options.branch, options.tag]) if (ref !== undefined) validateRef(ref);
    if (options.mode && !['tag', 'commit'].includes(options.mode)) fail('--mode must be tag or commit.');
    const commits = [options['frontend-commit'], options['server-commit']];
    if (commits.some(Boolean) && (!commits.every(Boolean) || commits.some(id => !/^[0-9a-f]{7,40}$/i.test(id)))) fail('Provide both --frontend-commit and --server-commit as 7-40 hexadecimal commit IDs.');
    if (options.tag && (options.mode === 'commit' || commits.some(Boolean))) fail('--tag cannot be combined with commit mode or commit IDs.');
    if (commits.some(Boolean) && options.mode === 'tag') fail('Commit IDs require commit mode.');
    if (options['local-source'] && (options.mode || options.tag || commits.some(Boolean))) fail('Version selection flags cannot be used with --local-source.');
}

function runGit(args, cwd) {
    const result = spawnSync('git', args, {
        cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true,
    });
    if (result.error || result.status !== 0) fail(`git ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    return result.stdout.trim();
}

export function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Reject junctions/symlinks in managed paths instead of writing through them.
export function safePath(root, target) {
    if (!inside(root, target) || root === target) fail(`Unsafe managed path: ${target}`);
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep)) {
        cursor = path.join(cursor, part);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) fail(`Symlink/junction is not supported: ${cursor}`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function hostInfo(root) {
    const pkg = readJson(path.join(root, 'package.json'));
    const minimum = pkg.name === 'luker' ? [2, 7, 0] : pkg.name === 'sillytavern' ? [1, 16, 0] : null;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(pkg.version || '');
    if (!minimum || !match) fail(`Not a supported SillyTavern/Luker host: ${root}`);
    const numbers = match.slice(1, 4).map(Number);
    let comparison = 0;
    for (let i = 0; i < 3 && !comparison; i++) comparison = numbers[i] - minimum[i];
    if (comparison < 0 || (comparison === 0 && pkg.version.includes('-'))) fail(`${pkg.name} requires >= ${minimum.join('.')}, found ${pkg.version}`);
    for (const file of ['server.js', 'src/plugin-loader.js', 'src/endpoints/google.js', 'public/scripts/extensions']) {
        if (!exists(path.join(root, file))) fail(`Host is incomplete: missing ${file}`);
    }
    return pkg;
}

export function discoverHosts() {
    // Running from a host (or one of its subdirectories) is an explicit context.
    // Prefer it over a different installation under HOME.
    let current = process.cwd();
    while (true) {
        try { hostInfo(current); return [fs.realpathSync(current)]; } catch { /* continue upward */ }
        if (path.dirname(current) === current) break;
        current = path.dirname(current);
    }
    const candidates = [path.join(os.homedir(), 'SillyTavern'), path.join(os.homedir(), 'Luker')];
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    while (path.dirname(cursor) !== cursor) { candidates.push(cursor); cursor = path.dirname(cursor); }
    const valid = [...new Set(candidates.filter(exists).map(p => fs.realpathSync(p)))].filter(p => {
        try { hostInfo(p); return true; } catch { return false; }
    });
    return valid;
}

function findHost(options) {
    if (options.host) return fs.realpathSync(path.resolve(options.host));
    const valid = discoverHosts();
    if (valid.length !== 1) fail('Specify --host PATH (no unique host found).');
    return valid[0];
}

export function editConfig(text, yaml, preserve = false) {
    const doc = yaml.parseDocument(text);
    if (doc.errors.length) fail(`Invalid YAML: ${doc.errors.map(e => e.message).join('; ')}`);
    if (!yaml.isMap(doc.contents)) fail('Host config must be a YAML mapping.');
    const config = doc.toJS();
    if (preserve) return { config, next: text };
    if (config.extensions?.enabled === false) fail('extensions.enabled is false; enable frontend extensions in the host first.');
    doc.set('enableServerPlugins', true);
    const changed = config.enableServerPlugins !== true;
    let next = changed ? doc.toString({ lineWidth: 0 }) : text;
    if (changed && text.includes('\r\n')) next = next.replace(/\r?\n/g, '\r\n');
    return { config, next };
}

function manifestIdentity(directory, name) {
    try {
        if (name === SERVER) return readJson(path.join(directory, 'package.json')).name === 'st-vertex-paygo-server';
        const manifest = readJson(path.join(directory, 'manifest.json'));
        return manifest.display_name === 'Vertex AI PayGo Tiers';
    } catch { return false; }
}

function rejectDuplicates(globalDir, pluginsDir, dataRoot, components) {
    const extensionRoots = [globalDir];
    if (exists(dataRoot)) {
        for (const user of fs.readdirSync(dataRoot, { withFileTypes: true })) {
            if (user.isDirectory() || user.isSymbolicLink()) extensionRoots.push(path.join(dataRoot, user.name, 'extensions'));
        }
    }
    for (const component of components) {
        const directories = component.name === SERVER ? [pluginsDir] : extensionRoots;
        for (const directory of directories.filter(exists)) {
            for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!item.isDirectory() && !item.isSymbolicLink()) continue;
                const candidate = path.join(directory, item.name);
                if (path.resolve(candidate) === component.target) continue;
                if (item.name.toLowerCase() === component.name.toLowerCase() || manifestIdentity(candidate, component.name)) {
                    fail(`Duplicate ${component.name}: ${candidate}\nMove/remove this older copy before installing globally; its settings are not migrated.`);
                }
            }
        }
    }
}

function locateExisting(globalDir, pluginsDir, dataRoot, components) {
    const frontendRoots = [globalDir];
    if (exists(dataRoot)) {
        for (const item of fs.readdirSync(dataRoot, { withFileTypes: true })) {
            if (item.isDirectory() || item.isSymbolicLink()) frontendRoots.push(path.join(dataRoot, item.name, 'extensions'));
        }
    }
    for (const component of components) {
        const matches = [];
        for (const directory of (component.name === SERVER ? [pluginsDir] : frontendRoots).filter(exists)) {
            for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!item.isDirectory() && !item.isSymbolicLink()) continue;
                const candidate = path.join(directory, item.name);
                if (manifestIdentity(candidate, component.name)) matches.push(candidate);
            }
        }
        if (matches.length > 1) fail(`Multiple installed copies of ${component.name}; choose/remove duplicates first:\n${matches.join('\n')}`);
        if (matches.length === 1) component.target = matches[0];
    }
}

function validatePayload(directory, name) {
    if (!manifestIdentity(directory, name)) fail(`Unexpected plugin identity in ${directory}`);
    const entry = name === SERVER ? readJson(path.join(directory, 'package.json')).main : readJson(path.join(directory, 'manifest.json')).js;
    const isPayloadFile = file => typeof file === 'string' && inside(directory, path.resolve(directory, file)) && exists(path.resolve(directory, file)) && fs.statSync(path.resolve(directory, file)).isFile();
    if (!isPayloadFile(entry)) fail(`Missing/invalid plugin entry in ${directory}`);
    if (name === FRONTEND) {
        const manifest = readJson(path.join(directory, 'manifest.json'));
        if (manifest.css && !isPayloadFile(manifest.css)) fail(`Missing/invalid stylesheet in ${directory}`);
    }
}

function copySource(source, target) {
    const excluded = new Set(['.git', 'node_modules', '.env', '.DS_Store', '.npm-cache']);
    const copy = (from, to) => {
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) fail(`Source contains symlink: ${from}`);
        if (stat.isDirectory()) {
            fs.mkdirSync(to, { recursive: true });
            for (const name of fs.readdirSync(from)) {
                if (!excluded.has(name) && !name.startsWith('.env.')) copy(path.join(from, name), path.join(to, name));
            }
        } else if (stat.isFile()) { fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode); }
        else fail(`Unsupported source file: ${from}`);
    };
    copy(source, target);
}

function checkExisting(component, allowModified) {
    if (!exists(component.target)) return;
    if (!manifestIdentity(component.target, component.name)) fail(`Destination belongs to another plugin: ${component.target}`);
    if (allowModified) return;
    if (!exists(path.join(component.target, '.git'))) fail(`Existing non-Git installation: ${component.target}\nUse --replace-modified to replace it with a full backup.`);
    if (runGit(['status', '--porcelain'], component.target)) fail(`Local changes in ${component.target}; use --replace-modified to back up and replace.`);
}

function prepareUpdate(component, options) {
    if (!exists(component.target)) fail(`Cannot update: ${component.name} is not installed. Run the installation command first.`);
    if (!manifestIdentity(component.target, component.name)) fail(`Destination belongs to another plugin: ${component.target}`);
    if (exists(path.join(component.target, '.git'))) {
        component.oldHead = runGit(['rev-parse', 'HEAD'], component.target);
        component.modified = Boolean(runGit(['status', '--porcelain'], component.target));
        try { component.oldBranch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], component.target); }
        catch { component.oldBranch = null; }
        const metadataFile = path.join(component.target, '.git/paygo-updater.json');
        if (exists(metadataFile)) {
            const metadata = readJson(metadataFile);
            if (metadata.schema !== 1 || typeof metadata.branch !== 'string') fail(`Invalid updater metadata: ${metadataFile}`);
            validateRef(metadata.branch);
            component.oldMetadata = metadata;
            component.trackingBranch = metadata.branch;
        }
    }
    if (options['local-source']) {
        if (!options['replace-modified']) fail('Updating from local files requires --replace-modified; existing files and Git history will be backed up.');
    } else if (!options.branch && !options.tag) {
        component.branch = component.oldBranch || component.trackingBranch;
        if (!component.branch && component.oldHead) {
            // Old tag checkouts predate updater metadata. Resolve the tag using
            // Git, never package.json (v0.3.1 still declared version 0.3.0).
            try { runGit(['describe', '--tags', '--exact-match', 'HEAD'], component.target); component.branch = 'main'; }
            catch { fail(`Cannot infer the update branch for ${component.name}. Specify --branch NAME explicitly.`); }
        }
        if (!component.branch) component.branch = 'main'; // Legacy ZIP, after explicit replacement consent.
    }
    if (component.branch) validateRef(component.branch);
    checkExisting(component, options['replace-modified']);
}

function gitCommit(directory, ref) {
    try { return runGit(['rev-parse', '--verify', `${ref}^{commit}`], directory); }
    catch { return null; }
}

function ancestor(directory, older, newer) {
    try { runGit(['merge-base', '--is-ancestor', older, newer], directory); return true; }
    catch { return false; }
}

function prepareRemote(component, options, log) {
    const c = component;
    runGit(['clone', '--no-checkout', '--', remote(c.name), c.staged]);
    c.branch ||= 'main';
    let desiredTag = options.tag;
    let legacyTag = false;
    let branchHead = gitCommit(c.staged, `refs/remotes/origin/${c.branch}`);
    if (!branchHead) {
        if (!desiredTag && gitCommit(c.staged, `refs/tags/${c.branch}`)) {
            desiredTag = c.branch; // Backward-compatible --branch vX.Y.Z.
            legacyTag = true;
            c.branch = 'main';
            branchHead = gitCommit(c.staged, 'refs/remotes/origin/main');
        } else fail(`Unknown branch or tag: ${c.branch} in ${c.name}`);
    }
    if (!branchHead) fail(`Cannot find the tracking branch ${c.branch} in ${c.name}`);
    const explicitCommit = options[c.name === FRONTEND ? 'frontend-commit' : 'server-commit'];
    if (legacyTag && (options.mode === 'commit' || explicitCommit)) fail('A tag supplied through --branch cannot be combined with commit mode or commit IDs; use --tag for tags.');
    c.mode = options.mode || (desiredTag ? 'tag' : explicitCommit ? 'commit' : c.branch === 'main' ? 'tag' : 'commit');
    if (c.mode === 'tag' && c.branch !== 'main') fail('Tag mode is for main; use commit mode for development branches.');
    if (c.mode === 'tag') {
        if (!desiredTag) {
            try {
                desiredTag = runGit(['describe', '--tags', '--abbrev=0', branchHead], c.staged);
                // Two release tags may refer to the same commit. Break that tie
                // deterministically instead of depending on tag enumeration order.
                const taggedCommit = gitCommit(c.staged, `refs/tags/${desiredTag}`);
                desiredTag = runGit(['-c', 'versionsort.suffix=-', 'tag', '--points-at', taggedCommit, '--sort=-version:refname'], c.staged).split('\n')[0] || desiredTag;
            }
            catch { fail(`No reachable tag on main for ${c.name}. Publish a tag or explicitly use --mode commit.`); }
        }
        validateRef(desiredTag);
        c.tag = desiredTag;
        c.newHead = gitCommit(c.staged, `refs/tags/${desiredTag}`);
        if (!c.newHead || !ancestor(c.staged, c.newHead, branchHead)) fail(`Tag ${desiredTag} is not on main in ${c.name}`);
    } else {
        c.newHead = explicitCommit ? gitCommit(c.staged, explicitCommit) : branchHead;
        if (!c.newHead || (explicitCommit && !c.newHead.toLowerCase().startsWith(explicitCommit.toLowerCase())) || !ancestor(c.staged, c.newHead, branchHead)) fail(`Requested commit is not in ${c.name}/${c.branch} history.`);
    }
    if (options.update && c.oldHead && !options['replace-modified']) {
        if (!ancestor(c.staged, c.oldHead, branchHead)) fail(`${c.name} contains commits absent from the selected remote history (local commits or divergent history). Use --replace-modified only to back up and replace them.`);
        if (!ancestor(c.staged, c.oldHead, c.newHead)) {
            if (c.mode === 'tag' && !options.tag && !legacyTag && (c.oldBranch || c.trackingBranch || c.branch) === c.branch && ancestor(c.staged, c.newHead, c.oldHead)) {
                c.unchanged = true;
                log(`${c.name}: installed ${c.oldHead.slice(0, 8)} is ahead of tag ${c.tag}; keeping it until a newer tag (or choose --mode commit).`);
            } else fail(`${c.name}: selected version is older or divergent. Use --replace-modified to explicitly back up and replace it.`);
        }
    }
    if (c.mode === 'commit' && !explicitCommit) runGit(['checkout', '-B', c.branch, `refs/remotes/origin/${c.branch}`], c.staged);
    else runGit(['checkout', '--detach', c.newHead], c.staged);
    fs.writeFileSync(path.join(c.staged, '.git/paygo-updater.json'), JSON.stringify({ schema: 1, branch: c.branch, mode: c.mode, tag: c.tag || null, commit: c.newHead }, null, 2));
    const newBranch = c.mode === 'commit' && !explicitCommit ? c.branch : null;
    const sameChannel = c.oldMetadata?.branch === c.branch && c.oldMetadata?.mode === c.mode && c.oldMetadata?.tag === (c.tag || null);
    c.unchanged ||= Boolean(options.update && c.oldHead === c.newHead && c.oldBranch === newBranch && sameChannel && !c.modified);
    log(`${c.name}: ${c.oldHead?.slice(0, 8) || 'existing/new'} -> ${c.newHead.slice(0, 8)} (${c.mode === 'tag' ? `tag ${c.tag}` : `${c.branch}, commit mode`})`);
}

export function install(options, log = console.log) {
    validateOptions(options);
    if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js >= 20 is required.');
    const root = findHost(options);
    const termux = Boolean(process.env.TERMUX_VERSION || /\/com\.termux\//.test(process.env.PREFIX || ''));
    if (termux && /^\/(sdcard|storage|mnt\/media_rw)(\/|$)/.test(root)) fail('Termux host must be in its private $HOME, not Android shared storage.');
    const pkg = hostInfo(root);
    const configPath = path.resolve(root, options.config || 'config.yaml');
    safePath(root, configPath);
    if (options.update && !exists(configPath)) fail('Cannot update without the existing host config. Specify the active config with --config PATH.');
    const configSource = exists(configPath) ? configPath : path.join(root, 'default/config.yaml');
    if (!exists(configSource)) fail('No config.yaml or default/config.yaml found. Start the host once first.');
    let yaml;
    try { yaml = createRequire(path.join(root, 'package.json'))('yaml'); }
    catch (error) { fail(`Cannot load the host yaml dependency; ensure the host environment is complete. ${error.message}`); }
    const original = fs.readFileSync(configSource, 'utf8');
    const { config, next } = editConfig(original, yaml, options.update);
    if (config.dataRoot !== undefined && typeof config.dataRoot !== 'string') fail('dataRoot must be a string.');
    const dataRoot = path.resolve(root, options['data-root'] || config.dataRoot || './data');
    const actualDataRoot = exists(dataRoot) ? fs.realpathSync(dataRoot) : dataRoot;
    for (const key of ['serverPluginsPath', 'globalExtensionsPath']) {
        if (config[key] !== undefined && typeof config[key] !== 'string') fail(`${key} must be a string.`);
    }
    if (pkg.name !== 'luker' && (options['plugins-path'] || options['extensions-path'])) fail('Custom plugin paths are supported only for Luker.');
    const pluginsDir = path.resolve(root, options['plugins-path'] || (pkg.name === 'luker' && config.serverPluginsPath) || 'plugins');
    const globalDir = path.resolve(root, options['extensions-path'] || (pkg.name === 'luker' && config.globalExtensionsPath) || 'public/scripts/extensions/third-party');
    const names = [FRONTEND, SERVER];
    const components = names.map(name => ({
        name, target: path.join(name === SERVER ? pluginsDir : globalDir, name),
        branch: options.branch || (options.tag || !options.update ? 'main' : undefined),
    }));
    if (options.update) locateExisting(globalDir, pluginsDir, dataRoot, components);
    const backupBase = path.join(root, '.paygo-install-backups');
    const lock = path.join(root, '.paygo-install.lock');
    safePath(root, backupBase);
    safePath(root, lock);
    if (exists(lock)) fail(`Another/incomplete installation exists: ${lock}. Check that no installer is running before removing this lock.`);
    for (const component of components) {
        safePath(root, component.target);
        if (inside(component.target, configPath) || inside(component.target, backupBase) || components.some(c => c !== component && inside(component.target, c.target))) fail('Config, backup and plugin paths must not overlap.');
        if (inside(component.target, dataRoot) || inside(component.target, actualDataRoot)) fail('Host dataRoot must not be inside a plugin directory being replaced.');
        if (options.update) prepareUpdate(component, options);
        else checkExisting(component, options['replace-modified']);
        if (options['local-source']) {
            component.source = fs.realpathSync(path.resolve(options['local-source'], component.name));
            if (inside(component.source, root) || inside(root, component.source)) fail('Local source and host must be separate directories.');
            validatePayload(component.source, component.name);
        }
    }
    rejectDuplicates(globalDir, pluginsDir, dataRoot, components);
    log(`Host: ${pkg.name} ${pkg.version} — ${root}${termux ? ' (Termux)' : ''}`);
    log(`Config: ${configPath}\nData: ${dataRoot}\nScope: ${options.update ? 'keep existing installation locations' : 'all users (global extensions)'}`);
    for (const c of components) {
        const mode = options.mode || (options.tag ? 'tag' : options['frontend-commit'] ? 'commit' : c.branch === 'main' ? 'tag' : 'commit');
        log(`${c.name}: ${c.source || `${remote(c.name)} @ ${c.branch} (${mode}${options.tag ? `: ${options.tag}` : ''})`} -> ${c.target}`);
    }
    log(options.update ? 'Update mode: existing config and host data will be preserved.' : 'enableServerPlugins: true');
    if (options['dry-run']) { log('Dry run complete. No files changed; remote branches were not downloaded/verified.'); return; }
    if (!options['local-source']) runGit(['--version']);
    let work, backup;
    const replaced = [];
    let configChanged = false;
    const hadConfig = exists(configPath);
    const configMode = hadConfig ? fs.statSync(configPath).mode : 0o600;
    let pendingConfig;
    fs.mkdirSync(lock); // atomic exclusion between installers
    try {
        work = fs.mkdtempSync(path.join(root, '.paygo-install-stage-'));
        fs.chmodSync(work, 0o700);
        pendingConfig = path.join(work, 'config.yaml.tmp');
        for (const c of components) {
            c.staged = path.join(work, c.name);
            if (c.source) copySource(c.source, c.staged);
            else prepareRemote(c, options, log);
            validatePayload(c.staged, c.name);
            // Also reject symlinks in downloaded Git trees before activation.
            const inspect = directory => {
                for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
                    if (item.name === '.git') continue;
                    if (item.isSymbolicLink()) fail(`Plugin contains symlink: ${path.join(directory, item.name)}`);
                    if (item.isDirectory()) inspect(path.join(directory, item.name));
                }
            };
            inspect(c.staged);
        }
        const tagged = components.filter(c => c.mode === 'tag');
        if (tagged.length === 2 && tagged[0].tag !== tagged[1].tag) fail(`Frontend/server tags are not aligned (${tagged[0].tag} / ${tagged[1].tag}). Wait for matching tags or specify --tag NAME.`);
        if (options.update && components.every(c => c.unchanged)) {
            log('Already up to date. No plugins or config changed; no backup needed.');
            return;
        }
        // All downloads and validation finish before touching installed plugins.
        fs.mkdirSync(backupBase, { recursive: true, mode: 0o700 });
        backup = fs.mkdtempSync(path.join(backupBase, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
        fs.chmodSync(backup, 0o700);
        if (hadConfig) fs.copyFileSync(configPath, path.join(backup, 'config.yaml'));
        fs.writeFileSync(path.join(backup, 'restore.json'), JSON.stringify({
            host: root, configPath, hadConfig,
            components: components.map(c => ({ name: c.name, target: c.target, existed: exists(c.target), changed: !c.unchanged })),
        }, null, 2), { mode: 0o600 });
        for (const c of components) {
            if (c.unchanged) continue;
            fs.mkdirSync(path.dirname(c.target), { recursive: true });
            c.saved = path.join(backup, c.name);
            const state = { ...c, moved: false, activated: false };
            replaced.push(state);
            if (exists(c.target)) { fs.renameSync(c.target, c.saved); state.moved = true; }
            fs.renameSync(c.staged, c.target);
            state.activated = true;
        }
        if (!hadConfig || next !== original) {
            fs.writeFileSync(pendingConfig, next, { flag: 'wx', mode: configMode });
            fs.renameSync(pendingConfig, configPath);
            configChanged = true;
        }
        log(`${options.update ? 'Updated' : 'Installed'} successfully. Backup: ${backup}\nRestart the host and refresh the browser.${options.update ? '' : ' Configure Google credentials in the host UI.'}`);
    } catch (error) {
        const recoveryErrors = [];
        if (configChanged) {
            try {
                if (hadConfig) fs.copyFileSync(path.join(backup, 'config.yaml'), configPath);
                else fs.rmSync(configPath);
            } catch (e) { recoveryErrors.push(e.message); }
        }
        for (const c of replaced.reverse()) {
            try {
                safePath(root, c.target);
                if (c.activated) fs.rmSync(c.target, { recursive: true, force: true });
                if (c.moved) fs.renameSync(c.saved, c.target);
            } catch (e) { recoveryErrors.push(e.message); }
        }
        if (recoveryErrors.length) fail(`${error.message}\nAutomatic rollback incomplete: ${recoveryErrors.join('; ')}\nRecover from ${backup}`);
        fail(`${error.message}\nInstallation aborted; existing plugins/config restored or left unchanged.${backup ? ` Backup: ${backup}` : ''}`);
    } finally {
        // Cleanup must not hide the original failure or recovery instructions.
        for (const cleanup of [
            () => { if (pendingConfig && exists(pendingConfig)) fs.rmSync(pendingConfig, { force: true }); },
            () => { if (work) { safePath(root, work); fs.rmSync(work, { recursive: true, force: true }); } },
            () => fs.rmdirSync(lock),
        ]) {
            try { cleanup(); } catch (error) { console.error(`Cleanup warning: ${error.message}`); }
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) console.log(HELP);
        else install(options);
    } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
