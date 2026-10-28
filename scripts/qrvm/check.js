const fs = require('fs');
const path = require('path');

/// Static guards for the QRVM line. Run after both builds:
///   npm run compile && npm run compile:qrvm && node scripts/qrvm/check.js
///
/// 1. Every contract in both builds keeps the 20 byte build's ABI, except for
///    the deviations listed in ALLOWED (docs/QRVM.md explains each).
/// 2. No public mapping keyed by `address`, `intN`, `bytesN` or a contract
///    type survives in the effective QRVM sources: hypc's auto-getter reads
///    the wrong slot for those keys (OC-V3-02).

const ROOT = path.resolve(__dirname, '..', '..');
const BUILDS = { evm: path.join(ROOT, 'build', 'hyperion'), qrvm: path.join(ROOT, 'build', 'qrvm') };

const ALLOWED = {
  PauliV3Pool: ['-snapshotCumulativesInside(int24,int24)'],
  IPauliV3Pool: ['-snapshotCumulativesInside(int24,int24)'],
  IPauliV3PoolDerivedState: ['-snapshotCumulativesInside(int24,int24)'],
  PauliV3Factory: ['~constructor', '+poolCodeChunkA()', '+poolCodeChunkB()', '+poolCodeHash()', '+poolCreationCode()'],
  PauliV3PoolDeployer: ['+constructor', '+poolCodeChunkA()', '+poolCodeChunkB()', '+poolCodeHash()', '+poolCreationCode()'],
  PauliV2LibraryProbe: ['-initCodeHash()', '~pairFor(address,address,address)'],
  PoolAddressProbe: ['-initCodeHash()', '~computeAddress(address,address,address,uint24)'],
};

function artifacts(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const out = {};
  for (const [name, units] of Object.entries(index)) {
    for (const unit of units) out[`${unit}:${name}`] = JSON.parse(fs.readFileSync(path.join(dir, unit, `${name}.json`), 'utf8'));
  }
  return out;
}

const sig = (f) => (f.type === 'function' ? `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})` : f.type);
const shape = (f) => `${f.stateMutability}|${(f.outputs || []).map((o) => o.type).join(',')}|${(f.inputs || []).map((i) => i.type).join(',')}`;

function abiDiff() {
  const evm = artifacts(BUILDS.evm);
  const qrvm = artifacts(BUILDS.qrvm);
  const errors = [];
  for (const [id, q] of Object.entries(qrvm)) {
    const e = evm[id];
    if (!e) continue;
    const name = id.split(':').pop();
    const allowed = new Set(ALLOWED[name] || []);
    const index = (abi) => new Map(abi.filter((f) => f.type !== 'error').map((f) => [sig(f), f]));
    const [ei, qi] = [index(e.abi), index(q.abi)];
    const found = [];
    for (const [s, f] of ei) {
      if (!qi.has(s)) found.push(`-${s}`);
      else if (shape(f) !== shape(qi.get(s))) found.push(f.type === 'constructor' ? '~constructor' : `~${s}`);
    }
    for (const s of qi.keys()) if (!ei.has(s)) found.push(`+${s}`);
    for (const d of found) if (!allowed.has(d)) errors.push(`${id}: ${d}`);
    for (const d of allowed) if (!found.includes(d)) errors.push(`${id}: allowed deviation ${d} no longer occurs, update ALLOWED`);
  }
  return errors;
}

function getterLint() {
  const errors = [];
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, acc);
      else if (f.endsWith('.hyp')) acc.push(f);
    }
    return acc;
  };
  const base = path.join(ROOT, 'contracts');
  const overlay = path.join(ROOT, 'contracts-qrvm');
  const units = new Map();
  const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
  for (const f of walk(base)) units.set(rel(base, f), f);
  for (const f of walk(overlay)) units.set(rel(overlay, f), f);
  const bad = /mapping\s*\(\s*(address|int\d*|bytes\d+|I?[A-Z]\w*)\s+(?:\w+\s+)?=>[^;]*?\)\s*public\b/g;
  for (const [unit, file] of units) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(bad)) errors.push(`${unit}: public mapping keyed by ${m[1]} (OC-V3-02)`);
  }
  return errors;
}

const errors = [...abiDiff(), ...getterLint()];
for (const e of errors) console.error(`  ${e}`);
console.log(errors.length ? `${errors.length} problem(s)` : 'QRVM ABI and getter checks passed');
process.exitCode = errors.length ? 1 : 0;
