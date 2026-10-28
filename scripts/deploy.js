require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Web3 } = require('@theqrl/web3');
const { accountFromMnemonic } = require('./account');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'build', 'hyperion');
const DEPLOYMENTS = path.join(ROOT, 'deployments');

function artifactOf(name) {
  const index = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'index.json'), 'utf8'));
  const units = index[name];
  if (!units) throw new Error(`No artifact for "${name}". Run npm run build.`);
  if (units.length > 1) throw new Error(`"${name}" is ambiguous across ${units.join(', ')}`);
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, units[0], `${name}.json`), 'utf8'));
}

// The QRL libraries speak Q prefixed addresses throughout; only the compiler's
// source literals use the Z spelling. Both describe the same 20 bytes.
const normalize = (address) => (/^0x/i.test(address) ? 'Q' + address.slice(2) : address);

// A wallet backed proxy allowlists a few read methods, so a deploy fails deep
// inside web3 with an opaque error. Probing first turns that into one message.
async function preflight(url) {
  const probe = async (method, params) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    return response.json();
  };

  // The JSON-RPC namespace is `qrl_`, not `zond_`, even though the node
  // implementation is go-zond.
  const required = {
    qrl_blockNumber: [],
    qrl_getCode: ['Q0000000000000000000000000000000000000000', 'latest'],
    qrl_getTransactionCount: ['Q0000000000000000000000000000000000000000', 'latest'],
    qrl_sendRawTransaction: ['0x00'],
  };

  const blocked = [];
  for (const [method, params] of Object.entries(required)) {
    const result = await probe(method, params).catch(() => ({ error: { code: -1 } }));
    // -32601 is "method not found / not allowed". Any other error means the
    // node accepted the call and merely rejected the arguments, which is fine.
    if (result.error && result.error.code === -32601) blocked.push(method);
  }

  if (blocked.length > 0) {
    throw new Error(
      `${url} does not expose ${blocked.join(', ')}.\n` +
        'This endpoint is a wallet backend, not a general JSON-RPC node, so it cannot deploy.\n' +
        'Point QRL_RPC_URL at a gqrl node you control (default http://localhost:8545) and retry.'
    );
  }
}

async function deploy(web3, from, name, args) {
  const artifact = artifactOf(name);
  const contract = new web3.qrl.Contract(artifact.abi);
  const tx = contract.deploy({ data: artifact.bytecode, arguments: args });

  const gas = await tx.estimateGas({ from });

  let deployed;
  try {
    deployed = await tx.send({ from, gas: (gas * 12n) / 10n });
  } catch (error) {
    // web3 surfaces this as an empty "Returned error:" with the real cause
    // buried in innerError, which reads like a node fault rather than a
    // transport limit.
    const inner = JSON.stringify(error.innerError ?? '');
    if (inner.includes('too large')) {
      const initCode = (artifact.bytecode.length - 2) / 2;
      throw new Error(
        `${name} was rejected by the RPC endpoint: request body too large.\n` +
          `  init code        ${initCode} bytes\n` +
          '  signature + key  ~7300 bytes of ML-DSA-87 overhead per transaction\n' +
          '  proxy body cap   ~51180 bytes, which allows ~18250 bytes of init code\n' +
          'This is a transport limit, not a contract or build problem. Point\n' +
          'QRL_RPC_URL at an endpoint without a body cap and retry.'
      );
    }
    throw error;
  }

  const address = normalize(deployed.options.address);
  console.log(`${name.padEnd(24)} ${address}`);
  return { contract: deployed, address };
}

async function reuseOrDeploy(web3, from, name, args, existing) {
  if (!existing) return deploy(web3, from, name, args);

  const address = normalize(existing);
  if ((await web3.qrl.getCode(address)) === '0x') {
    throw new Error(`${name} was pinned to ${address} but there is no code there.`);
  }
  const contract = new web3.qrl.Contract(artifactOf(name).abi, address);
  console.log(`${name.padEnd(24)} ${address}  (reused)`);
  return { contract, address };
}

function record(network, entries) {
  fs.mkdirSync(DEPLOYMENTS, { recursive: true });
  const file = path.join(DEPLOYMENTS, `${network}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...entries }, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, file)}`);
}

async function main() {
  const which = (process.env.DEPLOY || 'all').toLowerCase();
  const url = process.env.QRL_RPC_URL;
  const network = process.env.DEPLOY_NETWORK || 'zondTestnet';
  if (!url) throw new Error('QRL_RPC_URL is not set in .env');

  await preflight(url);

  const web3 = new Web3(url);
  const { account } = accountFromMnemonic(web3, process.env.DEPLOYER_MNEMONIC);
  web3.qrl.accounts.wallet.add(account);
  const from = account.address;

  const chainId = await web3.qrl.getChainId();
  const balance = await web3.qrl.getBalance(from);

  console.log(`network  ${network} (chainId ${chainId})`);
  console.log(`deployer ${normalize(from)}`);
  // The QRL fork names the base unit Planck, not wei.
  console.log(`balance  ${web3.utils.fromPlanck(balance, 'quanta')} QRL\n`);
  if (balance === 0n) throw new Error('Deployer has no balance. Fund it from the testnet faucet first.');

  const wqrlEnv = process.env.WQRL_ADDRESS;
  if (!wqrlEnv) {
    throw new Error(
      'WQRL_ADDRESS is not set. A WQRL contract already exists on the testnet; set it in .env rather than deploying another.'
    );
  }
  const wqrl = normalize(wqrlEnv);
  if ((await web3.qrl.getCode(wqrl)) === '0x') throw new Error(`No contract code at WQRL_ADDRESS ${wqrl}`);
  console.log(`${'WQRL (existing)'.padEnd(24)} ${wqrl}`);

  const out = { wqrl };

  if (which === 'all' || which === 'v2') {
    const feeToSetter = process.env.V2_FEE_TO_SETTER ? normalize(process.env.V2_FEE_TO_SETTER) : from;

    // Deployment can stop part way through when a transaction exceeds the RPC
    // body limit, so an already deployed factory is reused rather than
    // duplicated. Its pair init code hash is checked below either way.
    const factory = await reuseOrDeploy(web3, from, 'PauliV2Factory', [feeToSetter], process.env.V2_FACTORY);
    const router = await reuseOrDeploy(
      web3,
      from,
      'PauliV2Router02',
      [factory.address, wqrl],
      process.env.V2_ROUTER
    );

    // A mismatch means PauliV2Library.PAIR_INIT_CODE_HASH is stale, and every
    // router call would silently target an address with no code.
    const onChain = await factory.contract.methods.pairCodeHash().call();
    const expected = web3.utils.keccak256(artifactOf('PauliV2Pair').bytecode);
    if (onChain.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`V2 pair init code hash mismatch: chain ${onChain} vs artifact ${expected}`);
    }

    out.v2 = {
      factory: factory.address,
      router02: router.address,
      pairInitCodeHash: expected,
      feeToSetter: normalize(feeToSetter),
    };
  }

  if (which === 'all' || which === 'v3') {
    const factory = await deploy(web3, from, 'PauliV3Factory', []);
    const router = await deploy(web3, from, 'SwapRouter', [factory.address, wqrl]);
    const quoter = await deploy(web3, from, 'Quoter', [factory.address, wqrl]);
    const descriptor = await deploy(web3, from, 'PauliV3PositionDescriptor', []);
    const positionManager = await deploy(web3, from, 'NonfungiblePositionManager', [
      factory.address,
      wqrl,
      descriptor.address,
    ]);
    const tickLens = await deploy(web3, from, 'TickLens', []);
    const migrator = await deploy(web3, from, 'V3Migrator', [factory.address, wqrl, positionManager.address]);

    out.v3 = {
      factory: factory.address,
      swapRouter: router.address,
      quoter: quoter.address,
      positionDescriptor: descriptor.address,
      positionManager: positionManager.address,
      tickLens: tickLens.address,
      migrator: migrator.address,
      poolInitCodeHash: web3.utils.keccak256(artifactOf('PauliV3Pool').bytecode),
    };
  }

  record(network, out);
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'write-addresses.js')], {
    stdio: 'inherit',
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
