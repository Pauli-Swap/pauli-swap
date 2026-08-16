const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');

const ARTIFACTS = path.resolve(__dirname, '..', 'build', 'hyperion');
const index = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'index.json'), 'utf8'));

function artifactOf(name) {
  if (name.includes(':')) {
    const [unit, contractName] = name.split(':');
    return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, unit, `${contractName}.json`), 'utf8'));
  }
  const units = index[name];
  if (!units) throw new Error(`No compiled artifact for "${name}". Run npm run compile.`);
  if (units.length > 1) {
    throw new Error(`"${name}" is ambiguous; qualify it as one of: ${units.map((u) => `${u}:${name}`).join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, units[0], `${name}.json`), 'utf8'));
}

async function factoryOf(name, signer) {
  const artifact = artifactOf(name);
  return new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer ?? (await ethers.provider.getSigner(0)));
}

async function deploy(name, args = [], signer) {
  const factory = await factoryOf(name, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

const MINIMUM_LIQUIDITY = 1000n;
const MaxUint256 = (1n << 256n) - 1n;

function expandTo18Decimals(n) {
  return BigInt(n) * 10n ** 18n;
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock('latest');
  return block.timestamp;
}

const deadline = async () => (await latestTimestamp()) + 3600;

module.exports = {
  artifactOf,
  factoryOf,
  deploy,
  expandTo18Decimals,
  latestTimestamp,
  deadline,
  MINIMUM_LIQUIDITY,
  MaxUint256,
};

