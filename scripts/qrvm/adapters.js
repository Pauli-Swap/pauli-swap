const fs = require('fs');
const path = require('path');
const { Web3 } = require('qrl-web3-qip55');
const { artifact, link, strip, create2Address } = require('./lib');

/// One interface over two chains so a single scenario can run on both:
///  - `qrvm`: the QRVM build on a QIP-55 node, signed with ML-DSA-87;
///  - `evm`:  the 20 byte build on Hardhat's in process EVM, the reference
///            that the 107 test suite already holds to Uniswap's behaviour.
/// Values come back normalized: integers as BigInt, tuples as arrays.

const MAX = (1n << 256n) - 1n;

function normalize(v) {
  if (typeof v === 'bigint' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return /^-?\d+$/.test(v) ? BigInt(v) : v;
  if (v && typeof v === 'object') {
    if ('__length__' in v) return Array.from({ length: Number(v.__length__) }, (_, i) => normalize(v[i]));
    if (Array.isArray(v) || typeof v.length === 'number') return Array.from(v, normalize);
  }
  return v;
}

function decodeError(abi, data) {
  if (!data || data === '0x') return '<no reason>';
  const hex = strip(data);
  if (hex.startsWith('08c379a0')) return abi.decodeParameter('string', '0x' + hex.slice(8));
  return customError(hex);
}

/// Custom error arguments are ABI words, 32 bytes on the EVM and 64 on QRVM,
/// so only the selector is comparable across the two chains.
const customError = (hex) => `<error 0x${hex.slice(0, 8)}>`;

class QrvmAdapter {
  constructor(chain, deployment) {
    this.name = 'qrvm';
    this.chain = chain;
    this.web3 = chain.web3;
    this.deployer = chain.address;
    this.deployment = deployment;
    this.zero = 'Q' + '0'.repeat(128);
    this.gas = {};
  }

  at(name, address) {
    return this.chain.at(name, address);
  }

  async deploy(name, args = []) {
    return this.chain.deploy(name, args);
  }

  addr(c) {
    return typeof c === 'string' ? c : c.options.address;
  }

  async call(c, method, args = [], { value = 0n } = {}) {
    const data = c.methods[method](...args).encodeABI();
    const raw = await this.web3.qrl.call({ from: this.deployer, to: this.addr(c), data, value: '0x' + BigInt(value).toString(16) });
    const outputs = c.options.jsonInterface.find((f) => f.name === method && f.type === 'function').outputs;
    const decoded = this.web3.qrl.abi.decodeParameters(outputs, raw);
    return outputs.length === 1 ? normalize(decoded[0]) : normalize(decoded);
  }

  async send(c, method, args = [], { value = 0n, tag } = {}) {
    const receipt = await this.chain.tx(c, method, args, { value });
    if (tag) this.gas[tag] = BigInt(receipt.gasUsed);
    return receipt;
  }

  encodeCall(c, method, args = []) {
    return c.methods[method](...args).encodeABI();
  }

  async revertReason(c, method, args = [], { value = 0n } = {}) {
    const r = await this.chain.expectRevert(c, method, args, { value });
    return r.reverted ? decodeError(this.web3.qrl.abi, r.data) : null;
  }

  async nativeBalance(a) {
    return this.chain.balance(this.addr(a));
  }

  async timestamp() {
    return BigInt((await this.web3.qrl.getBlock('latest')).timestamp);
  }

  encode(types, values) {
    return this.web3.qrl.abi.encodeParameters(types, values);
  }

  /// abi.encodePacked(token, fee, token, ...) with 64 byte addresses.
  path(tokens, fees) {
    let out = strip(this.addr(tokens[0]));
    fees.forEach((fee, i) => {
      out += fee.toString(16).padStart(6, '0') + strip(this.addr(tokens[i + 1]));
    });
    return '0x' + out;
  }

  keccak(hex) {
    return Web3.utils.keccak256(hex);
  }

  sortKey(a) {
    return BigInt('0x' + strip(this.addr(a)));
  }

  create2(deployer, salt, codeHash) {
    return create2Address(this.addr(deployer), salt, codeHash);
  }

  sameAddress(a, b) {
    return strip(this.addr(a)) === strip(this.addr(b));
  }

  async code(a) {
    return strip(await this.chain.code(this.addr(a)));
  }

  async rawCall(to, data) {
    try {
      const out = await this.web3.qrl.call({ from: this.deployer, to: this.addr(to), data });
      return { ok: true, data: out };
    } catch (error) {
      return { ok: false, data: (error.innerError || {}).data };
    }
  }
}

class EvmAdapter {
  constructor(hre) {
    this.name = 'evm';
    this.hre = hre;
    this.ethers = hre.ethers;
    this.root = path.resolve(__dirname, '..', '..', 'build', 'hyperion');
    this.index = JSON.parse(fs.readFileSync(path.join(this.root, 'index.json'), 'utf8'));
    this.gas = {};
  }

  async init() {
    [this.signer] = await this.ethers.getSigners();
    this.deployer = this.signer.address;
    this.zero = this.ethers.ZeroAddress;
    return this;
  }

  art(name) {
    let unit;
    if (name.includes(':')) [unit, name] = name.split(':');
    else unit = this.index[name][0];
    return JSON.parse(fs.readFileSync(path.join(this.root, unit, `${name}.json`), 'utf8'));
  }

  at(name, address) {
    const c = new this.ethers.Contract(address, this.art(name).abi, this.signer);
    c.label = name;
    return c;
  }

  async deploy(name, args = []) {
    const a = this.art(name);
    const c = await new this.ethers.ContractFactory(a.abi, a.bytecode, this.signer).deploy(...args);
    await c.waitForDeployment();
    c.label = name;
    return c;
  }

  addr(c) {
    return typeof c === 'string' ? c : c.target;
  }

  async call(c, method, args = [], { value = 0n } = {}) {
    const out = await c[method].staticCall(...args, { value });
    return normalize(out);
  }

  async send(c, method, args = [], { value = 0n, tag } = {}) {
    const receipt = await (await c[method](...args, { value })).wait();
    if (tag) this.gas[tag] = receipt.gasUsed;
    return receipt;
  }

  encodeCall(c, method, args = []) {
    return c.interface.encodeFunctionData(method, args);
  }

  async revertReason(c, method, args = [], { value = 0n } = {}) {
    try {
      await c[method].staticCall(...args, { value });
      return null;
    } catch (error) {
      const data = error.data || (error.info && error.info.error && error.info.error.data);
      if (!data || data === '0x') return '<no reason>';
      if (data.startsWith('0x08c379a0')) return this.ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
      return customError(data.slice(2));
    }
  }

  async nativeBalance(a) {
    return this.ethers.provider.getBalance(this.addr(a));
  }

  async timestamp() {
    return BigInt((await this.ethers.provider.getBlock('latest')).timestamp);
  }

  encode(types, values) {
    return this.ethers.AbiCoder.defaultAbiCoder().encode(types, values);
  }

  path(tokens, fees) {
    const types = [];
    const values = [];
    tokens.forEach((t, i) => {
      types.push('address');
      values.push(this.addr(t));
      if (i < fees.length) {
        types.push('uint24');
        values.push(fees[i]);
      }
    });
    return this.ethers.solidityPacked(types, values);
  }

  keccak(hex) {
    return this.ethers.keccak256(hex);
  }

  sortKey(a) {
    return BigInt(this.addr(a));
  }

  create2(deployer, salt, codeHash) {
    return this.ethers.getCreate2Address(this.addr(deployer), salt, codeHash);
  }

  sameAddress(a, b) {
    return this.addr(a).toLowerCase() === this.addr(b).toLowerCase();
  }

  async code(a) {
    return strip(await this.ethers.provider.getCode(this.addr(a)));
  }

  async rawCall(to, data) {
    try {
      return { ok: true, data: await this.ethers.provider.call({ to: this.addr(to), data }) };
    } catch (error) {
      return { ok: false, data: error.data };
    }
  }
}

module.exports = { QrvmAdapter, EvmAdapter, normalize, MAX, artifact, link };
