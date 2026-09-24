#!/usr/bin/env node
// Runs every *.selfcheck.{ts,mjs,cjs} in the repo. Discovery is by walk, not a
// list, so a new selfcheck is picked up with zero wiring. Exits 1 if any fail.
//
// Skip a check that needs network/credentials by adding its path to SKIP below.
import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { cpus } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['src'];
const SKIP = new Set([
  // paths (repo-relative) needing network or credentials — none today
]);

// Placeholders, never real credentials. Selfchecks only exercise pure functions,
// but several live in modules that build a Supabase client at import time (the
// repo-wide convention), so without a syntactically valid URL/key the import
// throws before a single assert runs. These values are obviously fake: if a
// check ever does reach the network it fails loudly rather than quietly talking
// to a real project.
const PLACEHOLDER_ENV = {
  SUPABASE_URL: 'http://selfcheck.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'selfcheck-placeholder-service-key',
  SUPABASE_ANON_KEY: 'selfcheck-placeholder-anon-key',
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name[0] === '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.selfcheck\.(ts|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = ROOTS.filter((r) => existsSync(join(ROOT, r)))
  .flatMap((r) => walk(join(ROOT, r)))
  .map((p) => relative(ROOT, p))
  .filter((p) => !SKIP.has(p))
  .sort();

const runner = (f) => (f.endsWith('.ts') ? ['npx', ['tsx', f]] : ['node', [f]]);

function run(file) {
  const t0 = Date.now();
  const [cmd, args] = runner(file);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...PLACEHOLDER_ENV, ...process.env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) =>
      resolve({ file, ok: code === 0, secs: ((Date.now() - t0) / 1000).toFixed(1), out })
    );
  });
}

const queue = [...files];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(cpus().length, 8) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await run(f);
      results.push(r);
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.secs}s  ${r.file}`);
    }
  })
);

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`\n--- ${r.file} ---\n${r.out.trim()}`);
console.log(`\n${results.length - failed.length}/${results.length} selfchecks passed`);
process.exit(failed.length ? 1 : 0);
