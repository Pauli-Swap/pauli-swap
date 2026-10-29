const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Web3 } = require('qrl-web3-qip55');
const { MLDSA87 } = require('qrl-wallet-qip55');
const { keccak_512 } = require('@noble/hashes/sha3');

/// Shared plumbing for the QRVM (QIP-55) line: 64 byte addresses, 512 bit
/// words, ML-DSA-87 accounts. The 20 byte testnet scripts one directory up stay
/// on the pinned @theqrl/web3 1.0.1; this line uses 1.0.3 under an npm alias so
/// the two never share a resolution. See docs/QRVM.md.

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS = path.join(ROOT, 'build', 'qrvm');
const DEPLOYMENTS = path.join(ROOT, 'deployments');

/// Reads only the QRVM env file. process.env is deliberately ignored: Hardhat
/// loads the testnet `.env` into it, and its QRL_RPC_URL is the public 20 byte
/// testnet.
function loadEnv() {
  const file = path.resolve(ROOT, process.env.QRVM_ENV || '.env.devnet');
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} missing; copy .env.devnet.example`);
  const env = dotenv.parse(fs.readFileSync(file));
  assertPrivate(env);
  // Settings that pick what a run does, not where it signs, may come from the
  // shell: QRVM_NETWORK=devnet-audit npm run deploy:qrvm.
  for (const key of ['QRVM_NETWORK', 'QRVM_ADD', 'AUDIT_CODE_ONLY']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/// Audit runs leave dozens of throwaway contracts behind, so this line only
/// talks to private networks unless ALLOW_PUBLIC_RPC=1 is set in the env file.
function assertPrivate(env) {
  if (env.ALLOW_PUBLIC_RPC === '1') return;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  if (!local.test(env.QRL_RPC_URL || '')) {
    throw new Error(`QRL_RPC_URL "${env.QRL_RPC_URL}" is not a private network; set ALLOW_PUBLIC_RPC=1 to override`);
  }
}

function artifact(name) {
  const index = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'index.json'), 'utf8'));
  let unit;
  if (name.includes(':')) [unit, name] = name.split(':');
  else {
    const units = index[name];
    if (!units) throw new Error(`No QRVM artifact for "${name}". Run npm run compile:qrvm.`);
    if (units.length > 1) throw new Error(`"${name}" is ambiguous across ${units.join(', ')}`);
    unit = units[0];
  }
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, unit, `${name}.json`), 'utf8'));
}

const strip = (hex) => hex.replace(/^(0x|Q)/i, '').toLowerCase();
const bytesOf = (hex) => Buffer.from(strip(hex), 'hex');

/// Replaces library placeholders. QRVM placeholders are 64 bytes wide, one
/// full address, at the offsets hypc reports.
function link(art, libraries) {
  let code = strip(art.bytecode);
  for (const [, libs] of Object.entries(art.linkReferences || {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      const address = libraries[lib];
      if (!address) throw new Error(`${art.contractName} needs library ${lib}`);
      const hex = strip(address);
      for (const { start, length } of refs) {
        if (hex.length !== length * 2) throw new Error(`${lib} address is ${hex.length / 2} bytes, slot is ${length}`);
        code = code.slice(0, start * 2) + hex + code.slice((start + length) * 2);
      }
    }
  }
  if (code.includes('__$')) throw new Error(`${art.contractName} has unlinked libraries`);
  return '0x' + code;
}

/// QIP-55 CREATE2: Keccak-512 over the domain tag, 0xff, the 64 byte deployer,
/// the salt widened to one 64 byte word and the keccak256 of the init code.
/// A bytes32 salt is the high half of its word, as the probe in docs/QRVM.md
/// shows; go-zond's `salt.Bytes64()` sees the right padded value.
function create2Address(deployer, salt32, initCodeHash) {
  const salt = Buffer.concat([bytesOf(salt32), Buffer.alloc(32)]);
  const data = Buffer.concat([Buffer.from('QRL-ADDR-v1'), Buffer.from([0xff]), bytesOf(deployer), salt, bytesOf(initCodeHash)]);
  return 'Q' + Buffer.from(keccak_512(data)).toString('hex');
}

/// Init code for a contract whose runtime code is `0x00 || payload`:
/// PUSH2 len, PUSH1 14, PUSH1 0, CODECOPY, PUSH2 len, PUSH1 0, RETURN. The
/// STOP prefix makes a call to the chunk a no-op; PauliV3PoolDeployer skips it.
/// No DUP on purpose: QRVM's pushes run to PUSH64, which moves DUP1 from 0x80
/// to 0xa0, while PUSH1/PUSH2, CODECOPY and RETURN keep their EVM values.
function codeChunkInitCode(payload) {
  const runtime = Buffer.concat([Buffer.from([0x00]), bytesOf(payload)]);
  if (runtime.length > 0xffff) throw new Error('chunk too large');
  const [hi, lo] = [runtime.length >> 8, runtime.length & 0xff];
  const prefix = Buffer.from([0x61, hi, lo, 0x60, 0x0e, 0x60, 0x00, 0x39, 0x61, hi, lo, 0x60, 0x00, 0xf3]);
  return { initCode: '0x' + Buffer.concat([prefix, runtime]).toString('hex'), runtime: '0x' + runtime.toString('hex') };
}

class Chain {
  constructor(env) {
    this.env = env;
    this.web3 = new Web3(env.QRL_RPC_URL);
    const words = (env.DEPLOYER_MNEMONIC || '').trim().split(/\s+/);
    if (words.length !== 34) throw new Error(`DEPLOYER_MNEMONIC must be 34 words, got ${words.length}`);
    const wallet = MLDSA87.newWalletFromMnemonic(words.join(' '));
    this.account = this.web3.qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
    if (strip(this.account.address).length !== 128) {
      throw new Error(`derived a ${strip(this.account.address).length / 2} byte address; QIP-55 needs 64`);
    }
    this.address = this.account.address;
    this.receipts = [];
  }

  async init() {
    this.chainId = Number(await this.web3.qrl.getChainId());
    if (this.env.QRL_CHAIN_ID && Number(this.env.QRL_CHAIN_ID) !== this.chainId) {
      throw new Error(`node reports chain ${this.chainId}, env expects ${this.env.QRL_CHAIN_ID}`);
    }
    return this;
  }

  /// Signs locally and submits. The nonce is the pending one, floored at one
  /// past the last nonce this process used: on the devnet a node has answered
  /// the pending count one short right after returning the previous receipt,
  /// and the resend was rejected as an underpriced replacement.
  async send({ to, data = '0x', value = 0n, gas, label }) {
    const from = this.address;
    const [pending, block] = await Promise.all([
      this.web3.qrl.getTransactionCount(from, 'pending'),
      this.web3.qrl.getBlock('latest'),
    ]);
    const nonce = this.nextNonce !== undefined && this.nextNonce > BigInt(pending) ? this.nextNonce : BigInt(pending);
    if (!gas) {
      const estimate = await this.web3.qrl.estimateGas({ from, to, data, value: '0x' + BigInt(value).toString(16) });
      gas = (BigInt(estimate) * 13n) / 10n + 20000n;
    }
    const tip = 1_000_000_000n;
    const baseFee = BigInt(block.baseFeePerGas || 7);
    const signed = await this.account.signTransaction({
      ...(to ? { to } : {}),
      data,
      value: BigInt(value).toString(),
      gas: gas.toString(),
      nonce: Number(nonce),
      chainId: this.chainId,
      type: 2,
      maxPriorityFeePerGas: tip.toString(),
      maxFeePerGas: (baseFee * 2n + tip).toString(),
    });
    const receipt = await this.web3.qrl.sendSignedTransaction(signed.rawTransaction);
    this.nextNonce = nonce + 1n;
    if (BigInt(receipt.status) !== 1n) throw new Error(`${label || 'transaction'} reverted in ${receipt.transactionHash}`);
    this.receipts.push({ label, hash: receipt.transactionHash, block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed) });
    return receipt;
  }

  async deployCode(initCode, label) {
    const receipt = await this.send({ data: initCode, label: `deploy ${label}` });
    return receipt.contractAddress;
  }

  async deploy(name, args = [], libraries = {}) {
    const art = artifact(name);
    const bytecode = link(art, libraries);
    const data = new this.web3.qrl.Contract(art.abi).deploy({ data: bytecode, arguments: args }).encodeABI();
    const address = await this.deployCode(data, name.split(':').pop());
    return this.at(name, address);
  }

  at(name, address) {
    const c = new this.web3.qrl.Contract(artifact(name).abi, address);
    c.label = name.split(':').pop();
    return c;
  }

  call(contract, method, ...args) {
    return contract.methods[method](...args).call({ from: this.address });
  }

  tx(contract, method, args = [], { value = 0n, gas } = {}) {
    const data = contract.methods[method](...args).encodeABI();
    return this.send({ to: contract.options.address, data, value, gas, label: `${contract.label}.${method}` });
  }

  /// Runs a call that must revert and returns the revert data, so callers can
  /// assert on the reason the same way upstream's tests do.
  async expectRevert(contract, method, args = [], { value = 0n } = {}) {
    const data = contract.methods[method](...args).encodeABI();
    try {
      await this.web3.qrl.call({ from: this.address, to: contract.options.address, data, value: '0x' + BigInt(value).toString(16) });
    } catch (error) {
      const inner = error.innerError || error.cause || {};
      return { reverted: true, data: inner.data || error.data, message: inner.message || error.message };
    }
    return { reverted: false };
  }

  code(address) {
    return this.web3.qrl.getCode(address);
  }

  balance(address) {
    return this.web3.qrl.getBalance(address).then(BigInt);
  }
}

function writeDeployment(network, data) {
  fs.mkdirSync(DEPLOYMENTS, { recursive: true });
  const file = path.join(DEPLOYMENTS, `${network}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

function readDeployment(network) {
  return JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, `${network}.json`), 'utf8'));
}

module.exports = {
  ROOT,
  loadEnv,
  artifact,
  link,
  create2Address,
  codeChunkInitCode,
  Chain,
  writeDeployment,
  readDeployment,
  strip,
};
