#!/usr/bin/env node
// Opens the interactive Valentine showcase (docs/showcase/index.html) in the browser.
// Mirrors scripts/plans.mjs — same open-command precedence, works with `node` or `bun`.
//
//   bun run showcase          # open the showcase
//   npm run showcase          # same, via node
//
// Open command precedence: $Z_AGENT_BROWSER → `open` (macOS) → `start` (win) → `xdg-open`.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SHOWCASE = path.join(ROOT, 'docs', 'showcase', 'index.html');

if (!fs.existsSync(SHOWCASE)) {
  console.error(`Showcase not found at ${SHOWCASE}`);
  process.exit(1);
}

function openInBrowser(file) {
  const url = `file://${file}`;
  const custom = process.env.Z_AGENT_BROWSER;
  let cmd, args;
  if (custom) {
    cmd = custom; args = ['open', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', err => {
    console.error(`Could not open with "${cmd}": ${err.message}`);
    console.error(`Open it manually:\n  ${url}`);
  });
  child.unref();
  console.log(`Opening Valentine showcase → ${url}`);
}

openInBrowser(SHOWCASE);
