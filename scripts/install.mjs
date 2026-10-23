#!/usr/bin/env node
// Shared installer for Windows, macOS, Linux, WSL and Termux. No npm install here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import updateChannel from './update-channel.cjs';

const { inferUpdateChannel, selectUpdateMode } = updateChannel;

export const HELP = `PayGo suite installer (Node.js >= 20)
Usage: node scripts/install.mjs --host <SillyTavern-or-Luker-directory> [options]

  --host PATH             Existing, stopped SillyTavern >=1.16 / Luker >=2.7
  --update                Update installed components; preserve config and branches
  --component NAME        frontend, server or all (default: all)
  --branch NAME           Component refs (install: main; update: keep each)
  --mode tag|commit       main defaults to tag; other branches default to commit
  --tag NAME              Select a specific tag (default: each repo's latest)
  --frontend-commit SHA   Exact frontend commit
  --server-commit SHA     Exact server commit
  --local-source PATH     Offline source directory containing ST-Vertex-PayGo
                          and ST-Vertex-PayGo-Server (copies current files)
  --config PATH           Host config file (relative to host; default config.yaml)
  --data-root PATH        Actual host data root, if overridden at startup
  --plugins-path PATH     Luker serverPluginsPath override (inside host)
  --extensions-path PATH  Luker globalExtensionsPath override (inside host)
  --replace-modified      Replace locally modified/unmanaged installs WITH backup
  --dry-run              Validate paths/config and show plan without writes/network
  --help, -h             Show help

Each component follows its own release tags and updates independently; an
update that would leave them on different protocol versions is held back.
Installs frontend globally for all host users. Close the host before running.
Existing plugins and config are backed up under <host>/.paygo-install-backups/.
No Google credentials, host source, or other plugins are configured.
Only existing SillyTavern and Luker hosts are supported.
`;

const FRONTEND = 'ST-Vertex-PayGo';
const SERVER = 'ST-Vertex-PayGo-Server';
const COMPONENT_NAMES = Object.freeze({ frontend: FRONTEND, server: SERVER });
// Kept in step with the server plugin's src/updater/compatibility.cjs.
const PROTOCOL_FILES = Object.freeze({ [FRONTEND]: 'src/constants.js', [SERVER]: 'src/protocol.cjs' });
const remote = name => `https://github.com/mananekoha114/${name}.git`;
const exists = p => fs.existsSync(p);
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const fail = message => { throw new Error(message); };

export function parseArgs(args) {
    const result = {};
    const values = new Set(['host', 'component', 'branch', 'mode', 'tag', 'frontend-commit', 'server-commit', 'local-source', 'config', 'data-root', 'plugins-path', 'extensions-path']);
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
    if (options.component !== undefined && !['frontend', 'server', 'all'].includes(options.component)) fail('--component must be frontend, server or all.');
    const commits = [options['frontend-commit'], options['server-commit']];
    if (commits.some(id => id !== undefined && !/^[0-9a-f]{7,40}$/i.test(id))) fail('Commit IDs must be 7-40 hexadecimal characters.');
    if (options['frontend-commit'] && options.component === 'server') fail('--frontend-commit cannot be used with --component server.');
    if (options['server-commit'] && options.component === 'frontend') fail('--server-commit cannot be used with --component frontend.');
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

function gitConfig(directory, key) {
    try { return runGit(['config', '--local', '--get', key], directory); }
    catch { return null; }
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
        if (component.name === SERVER && component.oldBranch) {
            component.oldRemote = gitConfig(component.target, `branch.${component.oldBranch}.remote`);
            component.oldMerge = gitConfig(component.target, `branch.${component.oldBranch}.merge`);
        }
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
        let headTag = null;
        if (!component.oldBranch && !component.trackingBranch && component.oldHead) {
            // Old tag checkouts predate updater metadata. Resolve the tag using
            // Git, never package.json (v0.3.1 still declared version 0.3.0).
            try { headTag = runGit(['describe', '--tags', '--exact-match', 'HEAD'], component.target); }
            catch { fail(`Cannot infer the update branch for ${component.name}. Specify --branch NAME explicitly.`); }
        }
        component.branch = inferUpdateChannel({
            symbolicBranch: component.oldBranch,
            recordedBranch: component.trackingBranch,
            headTag,
            allowUnmanaged: !component.oldHead, // Legacy ZIP, after explicit replacement consent.
        }).branch;
    }
    if (component.branch) validateRef(component.branch);
    checkExisting(component, options['replace-modified']);
}

function readProtocol(directory, name) {
    try {
        const match = /\bPROTOCOL_VERSION\s*=\s*(\d+)\s*;/.exec(fs.readFileSync(path.join(directory, PROTOCOL_FILES[name]), 'utf8'));
        return match ? Number(match[1]) : null;
    } catch { return null; }
}

// Components update independently, but the extension refuses a server with
// another protocol version. Apply the largest set of changes that keeps one
// protocol; an unknown version never constrains, and an already mismatched
// installation may still update because that is the only way out of it.
export function holdBackIncompatible(entries) {
    const changing = entries.filter(entry => entry.changing).map(entry => entry.name);
    const resulting = applied => entries.map(entry => (applied.has(entry.name) ? entry.target : entry.installed));
    const consistent = protocols => protocols.filter(p => p !== null).every((p, _, known) => p === known[0]);
    const candidates = [new Set(changing), ...changing.map(name => new Set([name])), new Set()];
    const applied = candidates.find(candidate => consistent(resulting(candidate))) ?? new Set(changing);
    const final = new Map(entries.map((entry, index) => [entry.name, resulting(applied)[index]]));
    const held = new Map();
    for (const name of changing.filter(candidate => !applied.has(candidate))) {
        const entry = entries.find(item => item.name === name);
        const other = entries.find(item => item.name !== name && final.get(item.name) !== null);
        if (other) held.set(name, `requires protocol v${entry.target}, but ${other.name} stays on v${final.get(other.name)}. Update ${other.name} as well, or wait for a compatible release.`);
    }
    return held;
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
    c.mode = selectUpdateMode({ branch: c.branch, mode: options.mode, tag: desiredTag, commit: explicitCommit });
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
    let pinned = c.mode === 'tag' || Boolean(explicitCommit);
    if (options.update && c.oldHead && !options['replace-modified']) {
        if (!ancestor(c.staged, c.oldHead, branchHead)) fail(`${c.name} contains commits absent from the selected remote history (local commits or divergent history). Use --replace-modified only to back up and replace them.`);
        if (!ancestor(c.staged, c.oldHead, c.newHead)) {
            if (c.mode === 'tag' && !options.tag && !legacyTag && (c.oldBranch || c.trackingBranch || c.branch) === c.branch && ancestor(c.staged, c.newHead, c.oldHead)) {
                log(`${c.name}: installed ${c.oldHead.slice(0, 8)} is ahead of tag ${c.tag}; keeping it until a newer tag (or choose --mode commit).`);
                if (c.name === SERVER) {
                    // Repair legacy detached/missing-upstream installs even
                    // when their official revision is ahead of the latest tag.
                    c.newHead = c.oldHead;
                    c.mode = c.oldMetadata?.mode || 'commit';
                    c.tag = c.oldMetadata?.tag || null;
                    pinned = c.mode === 'tag' || !c.oldBranch || c.oldRemote === '.';
                } else c.unchanged = true;
            } else fail(`${c.name}: selected version is older or divergent. Use --replace-modified to explicitly back up and replace it.`);
        }
    }
    const newBranch = c.name === SERVER || (c.mode === 'commit' && !explicitCommit) ? c.branch : null;
    if (newBranch) runGit(['checkout', '-B', newBranch, c.newHead], c.staged);
    else runGit(['checkout', '--detach', c.newHead], c.staged);
    if (c.name === SERVER) {
        // ST resolves @{u} before deciding whether to pull. Tags and explicit
        // SHAs still need an attached branch, but tracking origin would allow
        // ST to pull unreleased commits past the selected version. A local
        // self-upstream makes its fetch/log check a successful no-op. PayGo's
        // updater continues to select releases from a fresh origin clone.
        runGit(['config', '--local', `branch.${c.branch}.remote`, pinned ? '.' : 'origin'], c.staged);
        runGit(['config', '--local', `branch.${c.branch}.merge`, `refs/heads/${c.branch}`], c.staged);
    } else if (newBranch) {
        runGit(['branch', '--set-upstream-to', `origin/${c.branch}`, c.branch], c.staged);
    }
    fs.writeFileSync(path.join(c.staged, '.git/paygo-updater.json'), JSON.stringify({ schema: 1, branch: c.branch, mode: c.mode, tag: c.tag || null, commit: c.newHead }, null, 2));
    const sameChannel = c.oldMetadata?.branch === c.branch && c.oldMetadata?.mode === c.mode && c.oldMetadata?.tag === (c.tag || null);
    const sameUpstream = c.name !== SERVER || (c.oldRemote === (pinned ? '.' : 'origin') && c.oldMerge === `refs/heads/${c.branch}`);
    c.unchanged ||= Boolean(options.update && c.oldHead === c.newHead && c.oldBranch === newBranch && sameChannel && sameUpstream && !c.modified);
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
    const all = [FRONTEND, SERVER].map(name => ({
        name, target: path.join(name === SERVER ? pluginsDir : globalDir, name),
        branch: options.branch || (options.tag || !options.update ? 'main' : undefined),
    }));
    if (options.update) locateExisting(globalDir, pluginsDir, dataRoot, all);
    const chosen = COMPONENT_NAMES[options.component];
    let components = all.filter(c => !chosen || c.name === chosen);
    // A default update covers whatever is installed; naming a component
    // requires it to be installed.
    if (options.update && !chosen) {
        for (const c of components.filter(item => !exists(item.target))) log(`${c.name}: not installed; skipped.`);
        if (components.every(c => !exists(c.target))) fail('Cannot update: PayGo is not installed. Run the installation command first.');
        components = components.filter(c => exists(c.target));
    }
    // In update mode one component's problem is reported without stopping the
    // other. A fresh installation stays all-or-nothing.
    const attempt = (c, action) => {
        if (!options.update) return action();
        try { return action(); }
        catch (error) {
            c.blocked = error.message;
            log(`${c.name}: not updated — ${error.message}`);
            return undefined;
        }
    };
    const active = () => components.filter(c => !c.blocked);
    const backupBase = path.join(root, '.paygo-install-backups');
    const lock = path.join(root, '.paygo-install.lock');
    safePath(root, backupBase);
    safePath(root, lock);
    if (exists(lock)) fail(`Another/incomplete installation exists: ${lock}. Check that no installer is running before removing this lock.`);
    for (const component of components) {
        safePath(root, component.target);
        if (inside(component.target, configPath) || inside(component.target, backupBase) || components.some(c => c !== component && inside(component.target, c.target))) fail('Config, backup and plugin paths must not overlap.');
        if (inside(component.target, dataRoot) || inside(component.target, actualDataRoot)) fail('Host dataRoot must not be inside a plugin directory being replaced.');
        attempt(component, () => {
            if (options.update) prepareUpdate(component, options);
            else checkExisting(component, options['replace-modified']);
            if (options['local-source']) {
                component.source = fs.realpathSync(path.resolve(options['local-source'], component.name));
                if (inside(component.source, root) || inside(root, component.source)) fail('Local source and host must be separate directories.');
                validatePayload(component.source, component.name);
            }
        });
    }
    if (!active().length) fail(`Nothing was updated: ${components.map(c => `${c.name}: ${c.blocked}`).join(' ')}`);
    rejectDuplicates(globalDir, pluginsDir, dataRoot, active());
    log(`Host: ${pkg.name} ${pkg.version} — ${root}${termux ? ' (Termux)' : ''}`);
    log(`Config: ${configPath}\nData: ${dataRoot}\nScope: ${options.update ? 'keep existing installation locations' : 'all users (global extensions)'}`);
    for (const c of active()) {
        const mode = selectUpdateMode({ branch: c.branch, mode: options.mode, tag: options.tag, commit: options[c.name === FRONTEND ? 'frontend-commit' : 'server-commit'] });
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
        for (const c of active()) {
            c.staged = path.join(work, c.name);
            attempt(c, () => {
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
            });
        }
        // Compare the protocol each component would end up with, including a
        // component outside this run that stays as installed.
        const replacing = c => components.includes(c) && !c.blocked && !c.unchanged;
        const held = holdBackIncompatible(all.map(c => ({
            name: c.name,
            changing: replacing(c),
            installed: exists(c.target) ? readProtocol(c.target, c.name) : null,
            target: replacing(c) ? readProtocol(c.staged, c.name) : null,
        })));
        for (const [name, reason] of held) {
            if (!options.update) fail(`${name} ${reason}`);
            const c = components.find(item => item.name === name);
            c.blocked = reason;
            log(`${c.name}: not updated — ${reason}`);
        }
        const blocked = components.filter(c => c.blocked);
        if (options.update && components.every(c => c.unchanged || c.blocked)) {
            if (blocked.length) fail(`Nothing was updated: ${blocked.map(c => `${c.name}: ${c.blocked}`).join(' ')}`);
            log('Already up to date. No plugins or config changed; no backup needed.');
            return { blocked: [] };
        }
        // All downloads and validation finish before touching installed plugins.
        fs.mkdirSync(backupBase, { recursive: true, mode: 0o700 });
        backup = fs.mkdtempSync(path.join(backupBase, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
        fs.chmodSync(backup, 0o700);
        if (hadConfig) fs.copyFileSync(configPath, path.join(backup, 'config.yaml'));
        fs.writeFileSync(path.join(backup, 'restore.json'), JSON.stringify({
            host: root, configPath, hadConfig,
            components: components.map(c => ({ name: c.name, target: c.target, existed: exists(c.target), changed: replacing(c) })),
        }, null, 2), { mode: 0o600 });
        for (const c of components) {
            if (!replacing(c)) continue;
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
        log(`${options.update ? 'Updated' : 'Installed'} successfully: ${components.filter(replacing).map(c => c.name).join(', ')}. Backup: ${backup}\nRestart the host and refresh the browser.${options.update ? '' : ' Configure Google credentials in the host UI.'}`);
        if (blocked.length) log(`WARNING: ${blocked.map(c => `${c.name} was not updated: ${c.blocked}`).join('\n')}`);
        return { blocked: blocked.map(c => c.name) };
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
        else if (install(options)?.blocked?.length) process.exitCode = 1;
    } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
