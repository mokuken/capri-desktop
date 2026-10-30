#!/usr/bin/env node
'use strict';

// Installs (or removes) Capri's OpenCode plugin.
// OpenCode auto-loads every .js/.ts file in ~/.config/opencode/plugins/, so this just
// drops (or deletes) capri.js there. Existing files are backed up.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_NAME = 'capri.js';
const SOURCE = path.resolve(__dirname, '..', 'hooks', 'capri-opencode-plugin.js');

function configDir() {
  const base = process.env.OPENCODE_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  return base;
}
function pluginsDir() { return path.join(configDir(), 'plugins'); }
function pluginPath() { return path.join(pluginsDir(), PLUGIN_NAME); }

function status() {
  const file = pluginPath();
  try {
    const installed = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('CapriPlugin');
    return { file, installed, events: installed ? ['session', 'tool', 'permission'] : [] };
  } catch (err) {
    return { file, installed: false, events: [], error: err.message };
  }
}

function install() {
  const dir = pluginsDir();
  const file = pluginPath();
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.capri-backup-${stamp}`);
  }
  fs.copyFileSync(SOURCE, file);
  return { file, command: `opencode plugin ${file}`, events: 1 };
}

function uninstall() {
  const file = pluginPath();
  if (!fs.existsSync(file)) return { file, removed: false };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('CapriPlugin')) return { file, removed: false };
  fs.rmSync(file, { force: true });
  return { file, removed: true };
}

module.exports = { install, uninstall, status, EVENTS: ['SessionStart'] };

if (require.main === module) {
  const arg = process.argv[2];
  try {
    if (arg === '--uninstall') {
      const r = uninstall();
      console.log(r.removed ? `Capri OpenCode plugin removed from ${r.file}` : `No Capri OpenCode plugin found in ${r.file}`);
    } else if (arg === '--status') {
      const r = status();
      console.log(r.installed ? `Installed in ${r.file}` : `Not installed (${r.file})`);
    } else {
      const r = install();
      console.log(`Capri OpenCode plugin installed in ${r.file}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
