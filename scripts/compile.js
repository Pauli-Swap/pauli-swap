const fs = require('fs');
const path = require('path');
const hypc = require('@theqrl/hypc');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = path.join(ROOT, 'contracts');
const ARTIFACTS = path.join(ROOT, 'build', 'hyperion');

// Uniswap ships each package with its own optimizer budget and the compiled
// bytecode is part of the CREATE2 address derivation, so the grouping has to be
// stable across builds.
// V3 uses a low run count for the same reason Uniswap does: the pool and the
// factory that embeds its init code both sit close to the 24576 byte code size
// limit that go-zond enforces, and a higher count trades size for gas.
// V3 uses a low run count for the same reason Uniswap does: the pool, and the
// factory that embeds the pool's init code, both sit close to MAX_CODE_SIZE and
// a higher count trades size for gas. At 200 the factory has only ~150 bytes of
// headroom, which is why the size check below is a build error rather than a
// warning.
// V2 core stays at Uniswap's run count because HyperionV2Pair's compiled init
// code is hashed into PAIR_INIT_CODE_HASH; changing it would orphan an already
// deployed factory. The periphery is free to shrink, and has to: the QRL wallet
// RPC proxy caps a request body at ~51 KB, and an ML-DSA-87 signature plus
// public key already costs ~7.3 KB of that, leaving ~18 KB for init code.
const OPTIMIZER_RUNS = [
  ['contracts/v2/core/', 999999],
  ['contracts/v2/periphery/', 200],
  ['contracts/v3/', 200],
  ['contracts/test/', 200],
];

// go-zond params.MaxCodeSize / MaxInitCodeSize
const MAX_CODE_SIZE = 24576;
const MAX_INIT_CODE_SIZE = 2 * MAX_CODE_SIZE;

function listSources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, acc);
    else if (entry.name.endsWith('.hyp')) acc.push(full);
  }
  return acc;
}

const toUnit = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function runsFor(unit) {
  const match = OPTIMIZER_RUNS.find(([prefix]) => unit.startsWith(prefix));
  return match ? match[1] : 200;
}

// hypc's import callback does not tell us which unit issued the import, so
// relative specifiers cannot be resolved from inside it. Instead every source is
// pre-loaded and its import strings are rewritten to repo relative unit names,
// which the compiler then finds directly in the `sources` map.
function collectSources(files) {
  const sources = {};

  function resolve(spec, importer) {
    if (spec.startsWith('.')) {
      const unit = path.normalize(path.join(path.dirname(importer), spec)).split(path.sep).join('/');
      const disk = path.join(ROOT, unit);
      return fs.existsSync(disk) ? { unit, disk } : null;
    }
    const disk = path.join(ROOT, 'node_modules', spec);
    return fs.existsSync(disk) ? { unit: `node_modules/${spec}`, disk } : null;
  }

  function load(unit, disk) {
    if (sources[unit]) return;
    sources[unit] = { content: '' };
    const raw = fs.readFileSync(disk, 'utf8');
    sources[unit].content = raw.replace(
      /(import\s+(?:[\w*\s{},]+\s+from\s+)?)(["'])([^"']+)\2/g,
      (match, head, quote, spec) => {
        const target = resolve(spec, unit);
        if (!target) throw new Error(`Cannot resolve import "${spec}" from ${unit}`);
        load(target.unit, target.disk);
        return `${head}${quote}${target.unit}${quote}`;
      }
    );
  }

  for (const file of files) load(toUnit(file), file);
  return sources;
}

function writeArtifact(unit, name, contract) {
  const outDir = path.join(ARTIFACTS, unit);
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = {
    _format: 'hh-hyp-artifact-1',
    contractName: name,
    sourceName: unit,
    abi: contract.abi,
    bytecode: '0x' + (contract.zvm.bytecode.object || ''),
    deployedBytecode: '0x' + (contract.zvm.deployedBytecode.object || ''),
    methodIdentifiers: contract.zvm.methodIdentifiers || {},
    linkReferences: {},
    deployedLinkReferences: {},
  };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifact, null, 2));
  return artifact;
}

function main() {
  const files = fs.existsSync(SOURCES) ? listSources(SOURCES) : [];
  if (files.length === 0) {
    console.error('No .hyp sources found under contracts/.');
    process.exit(1);
  }

  const groups = new Map();
  for (const file of files) {
    const runs = runsFor(toUnit(file));
    if (!groups.has(runs)) groups.set(runs, []);
    groups.get(runs).push(file);
  }

  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const index = {};
  let failed = false;
  let count = 0;

  for (const [runs, groupFiles] of groups) {
    const sources = collectSources(groupFiles);
    const output = JSON.parse(
      hypc.compile(
        JSON.stringify({
          language: 'Hyperion',
          sources,
          settings: {
            optimizer: { enabled: true, runs },
            // Keeps the metadata hash out of the bytecode so that the CREATE2
            // init code hashes depend only on the sources and settings.
            metadata: { bytecodeHash: 'none' },
            outputSelection: {
              '*': {
                '*': [
                  'abi',
                  'zvm.bytecode.object',
                  'zvm.deployedBytecode.object',
                  'zvm.methodIdentifiers',
                  'storageLayout',
                ],
              },
            },
          },
        })
      )
    );

    for (const err of output.errors || []) {
      if (err.severity === 'error') {
        failed = true;
        console.error(err.formattedMessage);
      } else if (process.env.HYP_WARNINGS === '1') {
        console.warn(err.formattedMessage);
      }
    }
    if (failed) continue;

    for (const [unit, contracts] of Object.entries(output.contracts || {})) {
      if (unit.startsWith('node_modules/')) continue;
      // A unit pulled in as a dependency of another group is compiled twice, at
      // both groups' optimizer settings. Only the owning group emits it, so the
      // artifact always matches the settings the unit was assigned.
      if (runsFor(unit) !== runs) continue;
      for (const [name, contract] of Object.entries(contracts)) {
        // Uniswap ships a TransferHelper in both the V2 periphery and the V3
        // core package, so short names are not unique. Ambiguous names map to
        // every candidate unit and callers must qualify them as "unit:Name".
        const artifact = writeArtifact(unit, name, contract);
        const deployed = (artifact.deployedBytecode.length - 2) / 2;
        const initCode = (artifact.bytecode.length - 2) / 2;
        if (deployed > MAX_CODE_SIZE) {
          console.error(`${name} runtime bytecode is ${deployed} bytes, over the ${MAX_CODE_SIZE} byte limit.`);
          failed = true;
        }
        if (initCode > MAX_INIT_CODE_SIZE) {
          console.error(`${name} init code is ${initCode} bytes, over the ${MAX_INIT_CODE_SIZE} byte limit.`);
          failed = true;
        }
        (index[name] ||= []).push(unit);
        count++;
      }
    }
  }

  if (failed) process.exit(1);

  fs.writeFileSync(path.join(ARTIFACTS, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`hypc ${hypc.version()}`);
  console.log(`Compiled ${count} contracts from ${files.length} sources.`);
}

main();

