const { Web3 } = require('qrl-web3-qip55');
const { loadEnv, artifact, link, codeChunkInitCode, Chain, writeDeployment, strip } = require('./lib');

/// Deploys PauliSwap V2 and V3 to a QIP-55 network. Usage:
///   QRVM_ENV=.env.devnet node scripts/qrvm/deploy.js
/// The network name in deployments/ comes from QRVM_NETWORK.

const keccak = (hex) => Web3.utils.keccak256(hex);

async function main() {
  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'devnet';
  const chain = await new Chain(env).init();
  const startBlock = Number(await chain.web3.qrl.getBlockNumber());
  console.log(`network ${network}  chain ${chain.chainId}  block ${startBlock}`);
  console.log(`deployer ${chain.address}  balance ${(await chain.balance(chain.address)) / 10n ** 18n} QRL`);

  const out = { network, chainId: chain.chainId, deployer: chain.address, startBlock, contracts: {}, codeHashes: {} };
  const record = (name, contract) => {
    out.contracts[name] = contract.options ? contract.options.address : contract;
    console.log(`  ${name.padEnd(18)} ${out.contracts[name]}`);
    return contract;
  };

  // A private QIP-55 chain has no WQRL; the 20 byte testnet one cannot be
  // reused across address widths.
  const wqrl = env.WQRL_ADDRESS ? chain.at('WQRL', env.WQRL_ADDRESS) : await chain.deploy('WQRL');
  record('WQRL', wqrl);

  const feeToSetter = env.V2_FEE_TO_SETTER || chain.address;
  const v2Factory = record('PauliV2Factory', await chain.deploy('PauliV2Factory', [feeToSetter]));
  record('PauliV2Router02', await chain.deploy('PauliV2Router02', [v2Factory.options.address, wqrl.options.address]));
  out.codeHashes.PauliV2Pair = await chain.call(v2Factory, 'pairCodeHash');

  const oracle = record('Oracle', await chain.deploy('Oracle'));
  const poolInit = link(artifact('PauliV3Pool'), { Oracle: oracle.options.address });
  const half = Math.ceil((poolInit.length - 2) / 4);
  const parts = [poolInit.slice(2, 2 + half * 2), poolInit.slice(2 + half * 2)];
  const chunks = [];
  for (const [i, part] of parts.entries()) {
    const { initCode, runtime } = codeChunkInitCode(part);
    const address = await chain.deployCode(initCode, `pool code chunk ${'AB'[i]}`);
    if (strip(await chain.code(address)) !== strip(runtime)) throw new Error(`chunk ${'AB'[i]} code mismatch`);
    chunks.push(record(`PoolCodeChunk${'AB'[i]}`, address));
  }

  const v3Factory = record('PauliV3Factory', await chain.deploy('PauliV3Factory', chunks));
  const onChainPoolHash = await chain.call(v3Factory, 'poolCodeHash');
  if (onChainPoolHash !== keccak(poolInit)) throw new Error('factory reassembles a different pool init code');
  out.codeHashes.PauliV3Pool = onChainPoolHash;

  record('SwapRouter', await chain.deploy('SwapRouter', [v3Factory.options.address, wqrl.options.address]));
  record('Quoter', await chain.deploy('Quoter', [v3Factory.options.address, wqrl.options.address]));
  record('PauliV3PoolLens', await chain.deploy('PauliV3PoolLens'));
  const descriptor = record('PauliV3PositionDescriptor', await chain.deploy('PauliV3PositionDescriptor'));
  const npm = record('NonfungiblePositionManager', await chain.deploy('NonfungiblePositionManager', [
    v3Factory.options.address,
    wqrl.options.address,
    descriptor.options.address,
  ]));
  record('TickLens', await chain.deploy('TickLens'));
  record('V3Migrator', await chain.deploy('V3Migrator', [v3Factory.options.address, wqrl.options.address, npm.options.address]));

  for (const [name, address] of Object.entries(out.contracts)) {
    if (strip(await chain.code(address)).length === 0) throw new Error(`${name} has no code at ${address}`);
  }
  out.endBlock = Number(await chain.web3.qrl.getBlockNumber());
  out.deployedAt = new Date().toISOString();
  out.transactions = chain.receipts;
  console.log(`wrote ${writeDeployment(network, out)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
