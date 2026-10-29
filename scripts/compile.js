const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = path.join(ROOT, 'contracts');

// QRVM=1 builds for a QIP-55 chain (64 byte addresses, 512 bit words) instead
// of the 20 byte testnet. npm hypc 0.0.2 predates QRVM codegen, so that build
// needs a hypc compiled from hyperion main, and the files under
// contracts-qrvm/ replace their counterparts under contracts/ unit for unit.
// docs/QRVM.md lists every replacement and why it exists.
const QRVM = process.env.QRVM === '1' || process.argv.includes('--qrvm');
const OVERLAY = path.join(ROOT, 'contracts-qrvm');
const ARTIFACTS = path.join(ROOT, 'build', QRVM ? 'qrvm' : 'hyperion');
const OUTPUT_KEY = QRVM ? 'qrvm' : 'zvm';
// The published @theqrl/qrl-contracts 0.1.0 is 20 byte only (its Strings casts
// address through uint160), and the QIP-55 rewrite exists only on its main
// branch, pinned by commit under this npm alias.
const QIP55_CONTRACTS = 'qrl-contracts-qip55';

function makeCompiler() {
  if (!QRVM) {
    const hypc = require('@theqrl/hypc');
    return { compile: (input) => hypc.compile(input), version: () => hypc.version() };
  }
  const [cmd, args] = process.env.HYPC_BIN
    ? [process.env.HYPC_BIN, []]
    : ['docker', ['run', '--rm', '-i', process.env.HYPC_DOCKER_IMAGE || 'hypc:local']];
  const run = (extra, input) => {
    const result = spawnSync(cmd, [...args, ...extra], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`hypc exited ${result.status}: ${result.stderr}`);
    return result.stdout;
  };
  return {
    compile: (input) => run(['--standard-json'], input),
    version: () => (run(['--version']).match(/Version:\s*(\S+)/) || [])[1],
  };
}

const hypc = makeCompiler();

function diskFor(unit) {
  if (QRVM && unit.startsWith('contracts/')) {
    const overlay = path.join(OVERLAY, unit.slice('contracts/'.length));
    if (fs.existsSync(overlay)) return overlay;
  }
  return path.join(ROOT, unit);
}

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
// V2 core stays at Uniswap's run count because PauliV2Pair's compiled init
// code is hashed into PAIR_INIT_CODE_HASH; changing it would orphan an already
// deployed factory. The periphery is free to shrink, and has to: the QRL wallet
// RPC proxy caps a request body at ~51 KB, and an ML-DSA-87 signature plus
// public key already costs ~7.3 KB of that, leaving ~18 KB for init code.
const OPTIMIZER_RUNS = [
  ['contracts/v2/core/', 999999],
  ['contracts/v2/periphery/', 200],
  // On QRVM the pool is over MaxCodeSize at 200 runs and only fits at one, see
  // docs/QRVM.md. No init code hash is pinned on that line, so this is free.
  ['contracts/v3/', QRVM ? 1 : 200],
  // SwapRouter02 carries both protocols' swap paths; one run keeps it under
  // MaxCodeSize on QRVM the same way.
  ['contracts/router/', QRVM ? 1 : 200],
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
      const disk = diskFor(unit);
      return fs.existsSync(disk) ? { unit, disk } : null;
    }
    const pkg = QRVM ? spec.replace(/^@theqrl\/qrl-contracts\//, `${QIP55_CONTRACTS}/`) : spec;
    const disk = path.join(ROOT, 'node_modules', pkg);
    return fs.existsSync(disk) ? { unit: `node_modules/${pkg}`, disk } : null;
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

  for (const file of files) load(toUnit(file), diskFor(toUnit(file)));
  return sources;
}

function writeArtifact(unit, name, contract) {
  const outDir = path.join(ARTIFACTS, unit);
  fs.mkdirSync(outDir, { recursive: true });
  const out = contract[OUTPUT_KEY];
  const artifact = {
    _format: 'hh-hyp-artifact-1',
    contractName: name,
    sourceName: unit,
    abi: contract.abi,
    bytecode: '0x' + (out.bytecode.object || ''),
    deployedBytecode: '0x' + (out.deployedBytecode.object || ''),
    methodIdentifiers: out.methodIdentifiers || {},
    linkReferences: out.bytecode.linkReferences || {},
    deployedLinkReferences: out.deployedBytecode.linkReferences || {},
    immutableReferences: out.deployedBytecode.immutableReferences || {},
  };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifact, null, 2));
  return artifact;
}

function main() {
  const files = fs.existsSync(SOURCES) ? listSources(SOURCES) : [];
  if (QRVM && fs.existsSync(OVERLAY)) {
    // Overlay units with no counterpart under contracts/ are QRVM only.
    for (const file of listSources(OVERLAY)) {
      const twin = path.join(SOURCES, path.relative(OVERLAY, file));
      if (!fs.existsSync(twin)) files.push(twin);
    }
  }
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
                  `${OUTPUT_KEY}.bytecode.object`,
                  `${OUTPUT_KEY}.bytecode.linkReferences`,
                  `${OUTPUT_KEY}.deployedBytecode.object`,
                  `${OUTPUT_KEY}.deployedBytecode.linkReferences`,
                  `${OUTPUT_KEY}.deployedBytecode.immutableReferences`,
                  `${OUTPUT_KEY}.methodIdentifiers`,
                  'storageLayout',
                ],
              },
            },
          },
        })
      )
    );

    for (const err of output.errors || []) {
      // The hyperion main line flags itself as a pre-release on every build.
      if (err.errorCode === '3805') continue;
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

