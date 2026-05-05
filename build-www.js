#!/usr/bin/env node
// Copies the web app files into www/ for Capacitor, excluding Node.js build files.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', 'www', 'src', 'android', 'ios',
  'build-www.js', 'webpack.config.js', 'package.json', 'package-lock.json',
  'capacitor.config.json', '.git', '.DS_Store']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (SKIP.has(entry)) continue;
    const s = path.join(src, entry), d = path.join(dst, entry);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const root = __dirname;
const www  = path.join(root, 'www');
fs.rmSync(www, { recursive: true, force: true });
copyDir(root, www);
console.log('✅ www/ ready for Capacitor');
