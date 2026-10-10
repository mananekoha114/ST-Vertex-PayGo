#!/usr/bin/env node
// Derive update entry points from the reviewed online bootstrap launchers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(argument => argument !== '--check')) {
    console.error('Usage: node scripts/sync-update-launchers.mjs [--check]');
    process.exit(1);
}

function replaceExactly(text, before, after, expected = 1) {
    const count = text.split(before).length - 1;
    if (count !== expected) throw new Error(`Bootstrap layout changed: expected ${expected} occurrences of ${JSON.stringify(before)}, found ${count}.`);
    return text.split(before).join(after);
}

function derive(extension) {
    const sourceName = `bootstrap.${extension}`;
    let text = fs.readFileSync(path.join(root, sourceName), 'utf8').replace(/\r\n/g, '\n');
    text = replaceExactly(text, `bootstrap.${extension} [installer options]`, `update.${extension} [update options]`);
    text = replaceExactly(text,
        'Requires Node.js 20+ and Git. PAYGO_HOST selects the host; PAYGO_BRANCH selects plugin versions.',
        'Updates an existing PayGo installation. Requires Node.js 20+ and Git. PAYGO_HOST selects the host; PAYGO_BRANCH overrides the installed branch.');
    text = replaceExactly(text, 'Downloading the PayGo installer...', 'Downloading the PayGo updater...');
    if (extension === 'sh') {
        text = replaceExactly(text, 'paygo_bootstrap', 'paygo_update', 2);
        text = replaceExactly(text,
            'node "$temp_dir/source/scripts/install-online.mjs" "$@"',
            'node "$temp_dir/source/scripts/install-online.mjs" --update "$@"', 2);
        text = replaceExactly(text, '#!/bin/sh\n', `#!/bin/sh\n# Generated from ${sourceName} by scripts/sync-update-launchers.mjs; do not edit directly.\n`);
    } else {
        text = replaceExactly(text, '$forwardArgs = @($args)', "$forwardArgs = @('--update') + @($args)");
        text = `# Generated from ${sourceName} by scripts/sync-update-launchers.mjs; do not edit directly.\n${text}`;
    }
    return text;
}

try {
    // Derive both before writing, so layout changes cannot leave a partial refresh.
    const outputs = ['sh', 'ps1'].map(extension => ({ name: `update.${extension}`, text: derive(extension) }));
    let stale = false;
    for (const output of outputs) {
        const target = path.join(root, output.name);
        if (check) {
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output.text) {
                console.error(`${output.name} is stale; run node scripts/sync-update-launchers.mjs`);
                stale = true;
            }
        } else {
            fs.writeFileSync(target, output.text);
            console.log(`Generated ${output.name}`);
        }
    }
    if (stale) process.exitCode = 1;
    else if (check) console.log('Update launchers match bootstrap sources.');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
