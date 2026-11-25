#!/usr/bin/env node
/**
 * 将 src/settings/client/*.js 按文件名顺序拼接为 DSH 浏览器侧单文件 src/client.js。
 * 无外部依赖，修改任意前端分片后运行 `npm run build:client` 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS_DIR = path.join(ROOT, 'src', 'settings', 'client');
const OUT_FILE = path.join(ROOT, 'src', 'client.js');

const files = fs.readdirSync(PARTS_DIR)
  .filter((name) => name.endsWith('.js'))
  .sort((a, b) => a.localeCompare(b));

if (!files.length) {
  console.error('No client source parts found in', PARTS_DIR);
  process.exit(1);
}

const bundle = files
  .map((name) => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('');

fs.writeFileSync(OUT_FILE, bundle, 'utf8');
console.log(`Built src/client.js from ${files.length} parts (${bundle.split(/\r?\n/).length} lines).`);
