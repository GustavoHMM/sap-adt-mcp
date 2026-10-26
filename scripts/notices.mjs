// Writes build/THIRD-PARTY-NOTICES.md: the licenses of everything shipped in the
// installer (upstream server and its dependencies, Node.js, Electron/Chromium,
// native modules, and the libraries bundled into the app and the CLI).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from './npm.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'build', 'THIRD-PARTY-NOTICES.md');
const LICENSE_FILES = /^(licen[cs]e|copying|notice)(\..*)?$/i;

function licenseText(dir) {
  try {
    const file = fs.readdirSync(dir).find((n) => LICENSE_FILES.test(n));
    return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/** Production dependency tree of a package folder, as { name@version: dir }. */
function productionTree(cwd, workspace) {
  const args = ['ls', '--omit=dev', '--all', '--json', '--long', ...(workspace ? ['--workspace', workspace] : [])];
  let json;
  try {
    json = JSON.parse(npm(args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    json = JSON.parse(e.stdout);
  }
  const found = new Map();
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (!info.path || name.startsWith('@abap-adt-mcp/')) {
        walk(info.dependencies);
        continue;
      }
      const key = `${name}@${info.version}`;
      if (!found.has(key)) found.set(key, { name, version: info.version, license: info.license, dir: info.path });
      walk(info.dependencies);
    }
  };
  walk(json.dependencies);
  return found;
}

const sections = [];
const add = (title, license, text) => sections.push(`## ${title}\n\nLicense: ${license ?? 'see text'}\n\n\`\`\`\n${text ?? '(license text not included in the package)'}\n\`\`\`\n`);

// The upstream server, credited first: this app exists to package it.
const upstream = path.join(root, 'build', 'upstream');
add('mcp-abap-adt (mario-andreschak) — servidor MCP usado sem modificações', 'MIT', licenseText(upstream));
for (const dep of productionTree(upstream).values()) add(`${dep.name} ${dep.version} (mcp-abap-adt)`, dep.license, licenseText(dep.dir));

const nodeLicense = fs.readdirSync(path.join(root, 'build', '.cache')).find((n) => /^node-v[\d.]+-win-x64$/.test(n));
if (nodeLicense) add(`Node.js ${nodeLicense.split('-')[1]} (embedded in abap-adt-mcp.exe)`, 'MIT and others', licenseText(path.join(root, 'build', '.cache', nodeLicense)));

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
add('Electron', 'MIT', licenseText(electronDist));
sections.push('## Chromium and its dependencies (part of Electron)\n\nSee LICENSES.chromium.html next to the application executable.\n');

const seen = new Set();
for (const workspace of ['@abap-adt-mcp/cli', '@abap-adt-mcp/desktop']) {
  for (const [key, dep] of productionTree(root, workspace)) {
    if (seen.has(key) || dep.name === 'electron') continue;
    seen.add(key);
    add(`${dep.name} ${dep.version}`, dep.license, licenseText(dep.dir));
  }
}

const header = `# Avisos de terceiros / Third-party notices\n\nABAP ADT MCP é distribuído sob a licença MIT. Ele inclui os componentes abaixo, cada um com a sua licença.\n\nABAP ADT MCP is distributed under the MIT license. It includes the components below, each under its own license.\n\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, header + sections.join('\n'));
console.log(`[notices] ${sections.length} components -> build/THIRD-PARTY-NOTICES.md`);
