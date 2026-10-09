#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { HELP, discoverHosts, install, parseArgs } from './install.mjs';

export function onlineOptions(args, env = process.env) {
    const options = parseArgs(args);
    if (!options.host && env.PAYGO_HOST) options.host = env.PAYGO_HOST;
    if (!args.includes('--branch') && env.PAYGO_BRANCH) options.branch = env.PAYGO_BRANCH;
    // Reuse the CLI validator for environment-provided refs as well.
    parseArgs(['--branch', options.branch]);
    for (const [variable, flag] of [['PAYGO_DRY_RUN', 'dry-run'], ['PAYGO_REPLACE_MODIFIED', 'replace-modified']]) {
        if (env[variable] && !['0', '1'].includes(env[variable])) throw new Error(`${variable} must be 0 or 1.`);
        if (env[variable] === '1') options[flag] = true;
    }
    return options;
}

export function normalizeHostAnswer(answer, candidates = []) {
    const value = answer.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (/^\d+$/.test(value) && candidates.length) {
        const candidate = candidates[Number(value) - 1];
        if (!candidate) throw new Error('Invalid host number. Rerun and select one of the listed numbers.');
        return candidate;
    }
    if (!value) throw new Error('No host path supplied; installation cancelled.');
    if (value === '~') return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

export async function runOnline(args = process.argv.slice(2)) {
    const options = onlineOptions(args);
    if (options.help) {
        console.log(`${HELP}\nOnline environment: PAYGO_HOST, PAYGO_BRANCH, PAYGO_DRY_RUN=1, PAYGO_REPLACE_MODIFIED=1`);
        return;
    }
    console.log('PayGo online installer — only PayGo + Server; existing host environment required.');
    console.log('请先关闭 SillyTavern / Luker。安装完成后再启动宿主。');
    if (!options.host) {
        const candidates = discoverHosts();
        if (candidates.length === 1) options.host = candidates[0];
        else {
            if (!process.stdin.isTTY) {
                throw new Error('No unique host found and no interactive terminal is available. Run from the host directory, or set PAYGO_HOST / pass --host PATH.');
            }
            if (candidates.length) {
                console.log('发现多个宿主，请选择要安装的目录：');
                candidates.forEach((candidate, index) => console.log(`  ${index + 1}. ${candidate}`));
            } else console.log('未找到酒馆目录。请输入包含 server.js 和 config.yaml 的 SillyTavern / Luker 文件夹路径。');
            const prompt = createInterface({ input: process.stdin, output: process.stdout });
            try {
                options.host = normalizeHostAnswer(await prompt.question(candidates.length ? '序号或完整路径：' : '酒馆路径：'), candidates);
            } finally { prompt.close(); }
        }
    }
    install(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await runOnline(); }
    catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
