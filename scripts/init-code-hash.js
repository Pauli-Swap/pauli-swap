const fs = require('fs');
const path = require('path');
const { keccak256 } = require('ethers');

const ROOT = path.resolve(__dirname, '..');

// Each entry pins the CREATE2 init code hash a periphery library uses to derive
// pool addresses without an external call. Run after `npm run compile`, then
// compile again so the new constant is baked into the periphery bytecode.
const TARGETS = [
  {
    artifact: 'build/hyperion/contracts/v2/core/PauliV2Pair.hyp/PauliV2Pair.json',
    source: 'contracts/v2/periphery/libraries/PauliV2Library.hyp',
    constant: 'PAIR_INIT_CODE_HASH',
  },
  {
    artifact: 'build/hyperion/contracts/v3/core/PauliV3Pool.hyp/PauliV3Pool.json',
    source: 'contracts/v3/periphery/libraries/PoolAddress.hyp',
    constant: 'POOL_INIT_CODE_HASH',
  },
];

let changed = false;

for (const target of TARGETS) {
  const artifactPath = path.join(ROOT, target.artifact);
  const sourcePath = path.join(ROOT, target.source);
  if (!fs.existsSync(artifactPath) || !fs.existsSync(sourcePath)) continue;

  const { bytecode } = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (!bytecode || bytecode === '0x') {
    console.error(`${target.artifact} has no creation bytecode.`);
    process.exit(1);
  }

  const hash = keccak256(bytecode);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const pattern = new RegExp(`(${target.constant}\\s*=\\s*)(0x[0-9a-fA-F]{64})`);
  const match = source.match(pattern);

  if (!match) {
    console.error(`Could not find ${target.constant} in ${target.source}.`);
    process.exit(1);
  }

  if (match[2].toLowerCase() === hash) {
    console.log(`${target.constant} already up to date (${hash})`);
    continue;
  }

  fs.writeFileSync(sourcePath, source.replace(pattern, `$1${hash}`));
  console.log(`${target.constant} -> ${hash}`);
  changed = true;
}

if (changed) console.log('Recompile so the periphery picks up the new hashes.');

