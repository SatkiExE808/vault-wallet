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

// Patch Android manifest with the runtime permissions our JS uses
// (CAMERA for the QR scanner; clipboard read/write doesn't need a
// manifest line on modern Android). Idempotent — adds the line only if
// it isn't already there.
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let xml = fs.readFileSync(manifestPath, 'utf8');
  const wanted = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  ];
  let changed = false;
  for (const line of wanted) {
    if (!xml.includes(line)) {
      xml = xml.replace(/<application/, `    ${line}\n    <application`);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(manifestPath, xml);
    console.log('✅ AndroidManifest patched with CAMERA permission');
  }
}
