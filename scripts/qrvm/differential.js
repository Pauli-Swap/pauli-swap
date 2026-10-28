const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { loadEnv, Chain, ROOT } = require('./lib');
const { QrvmAdapter, EvmAdapter, MAX } = require('./adapters');

/// Differential test of the math libraries: the same inputs go through the
/// probes compiled for QRVM and through the 20 byte EVM build, and every
/// outcome, value or revert reason, has to be identical. Vectors concentrate
/// where 512 bit words could diverge: overflow edges of mulDiv, the extreme
/// ticks and prices, and wide random operands.
///
///   QRVM_ENV=.env.devnet npx hardhat run scripts/qrvm/differential.js

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const U128 = (1n << 128n) - 1n;
const U160 = (1n << 160n) - 1n;

/// xorshift128+, so a failing vector can be reproduced from its index.
function rng(seed) {
  let s0 = 0x9e3779b97f4a7c15n ^ BigInt(seed);
  let s1 = 0xbf58476d1ce4e5b9n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x = (x ^ (x << 23n)) & mask;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (s1 + y) & mask;
  };
  return (bits) => {
    let v = 0n;
    for (let i = 0n; i < BigInt(bits); i += 64n) v = (v << 64n) | next();
    return v & ((1n << BigInt(bits)) - 1n);
  };
}

function vectors() {
  const r = rng(55);
  const width = () => [8, 32, 64, 96, 128, 160, 200, 255, 256][Number(r(8) % 9n)];
  const v = [];
  const add = (probe, method, args) => v.push({ probe, method, args });

  for (const t of [MIN_TICK - 1, MIN_TICK, MIN_TICK + 1, -1, 0, 1, MAX_TICK - 1, MAX_TICK, MAX_TICK + 1]) {
    add('tick', 'getSqrtRatioAtTick', [t]);
  }
  for (let i = 0; i < 150; i++) add('tick', 'getSqrtRatioAtTick', [Number(r(21) % 1774545n) - MAX_TICK]);
  for (const p of [MIN_SQRT - 1n, MIN_SQRT, MIN_SQRT + 1n, 79228162514264337593543950336n, MAX_SQRT - 1n, MAX_SQRT]) {
    add('tick', 'getTickAtSqrtRatio', [p]);
  }
  for (let i = 0; i < 150; i++) add('tick', 'getTickAtSqrtRatio', [MIN_SQRT + (r(160) % (MAX_SQRT - MIN_SQRT))]);

  const mulDivEdges = [
    [MAX, MAX, MAX], [MAX, MAX, MAX - 1n], [MAX, 1n, 1n], [MAX, 2n, 1n], [MAX, 2n, 2n],
    [1n << 128n, 1n << 128n, 1n], [1n << 128n, 1n << 128n, 2n], [MAX, MAX, 0n], [0n, MAX, 1n],
    [(1n << 255n) + 1n, 2n, 2n], [MAX - 1n, MAX, MAX], [1n << 200n, 1n << 100n, 1n << 44n], [1n << 200n, 1n << 100n, (1n << 44n) - 1n],
  ];
  for (const e of mulDivEdges) {
    add('tick', 'mulDiv', e);
    add('tick', 'mulDivRoundingUp', e);
  }
  for (let i = 0; i < 150; i++) {
    const args = [r(width()), r(width()), r(width()) | 1n];
    add('tick', 'mulDiv', args);
    add('tick', 'mulDivRoundingUp', args);
  }

  for (let i = 0; i < 120; i++) {
    const a = MIN_SQRT + (r(160) % (MAX_SQRT - MIN_SQRT));
    const b = MIN_SQRT + (r(160) % (MAX_SQRT - MIN_SQRT));
    const l = r(width() > 128 ? 128 : width()) & U128;
    const up = Boolean(r(1));
    add('tick', 'getAmount0Delta', [a, b, l, up]);
    add('tick', 'getAmount1Delta', [a, b, l, up]);
  }
  for (const [x, y] of [[U128, 1n], [U128, -1n], [0n, -1n], [5n, -(1n << 127n)], [U128 - 5n, 5n]]) add('tick', 'addDelta', [x, y]);

  for (let i = 0; i < 120; i++) {
    const [amount, rin, rout] = [r(width() > 112 ? 112 : width()), r(112), r(112)];
    add('lib', 'getAmountOut', [amount, rin, rout]);
    add('lib', 'getAmountIn', [amount % (rout || 1n), rin, rout]);
  }
  add('lib', 'getAmountOut', [0n, 1n, 1n]);
  add('lib', 'getAmountIn', [5n, 10n, 5n]);
  return v.map((x, i) => ({ ...x, i, args: x.args.map((a) => (typeof a === 'bigint' && a > U160 && x.method.startsWith('getTick') ? a & U160 : a)) }));
}

async function outcome(a, probes, v) {
  const probe = probes[v.probe];
  const reason = await a.revertReason(probe, v.method, v.args);
  if (reason !== null) return `revert:${reason}`;
  const value = await a.call(probe, v.method, v.args);
  return `ok:${value}`;
}

async function main() {
  const env = loadEnv();
  const chain = await new Chain(env).init();
  const q = new QrvmAdapter(chain, null);
  const e = await new EvmAdapter(hre).init();
  const probes = {};
  for (const a of [q, e]) {
    probes[a.name] = { tick: await a.deploy('TickMathProbe'), lib: await a.deploy('PauliV2LibraryProbe') };
  }

  const list = vectors();
  const results = [];
  let mismatched = 0;
  for (const v of list) {
    const [oq, oe] = [await outcome(q, probes.qrvm, v), await outcome(e, probes.evm, v)];
    const match = oq === oe;
    if (!match) {
      mismatched++;
      console.log(`MISMATCH #${v.i} ${v.method}(${v.args.join(', ')})\n  qrvm ${oq}\n  evm  ${oe}`);
    }
    results.push({ i: v.i, method: v.method, args: v.args.map(String), qrvm: oq, evm: oe, match });
  }
  const byMethod = {};
  for (const r of results) {
    const m = (byMethod[r.method] ||= { vectors: 0, reverts: 0, mismatched: 0 });
    m.vectors++;
    if (r.evm.startsWith('revert')) m.reverts++;
    if (!r.match) m.mismatched++;
  }
  const report = { network: env.QRVM_NETWORK, chainId: chain.chainId, ranAt: new Date().toISOString(), total: results.length, mismatched, byMethod, results };
  const dir = path.join(ROOT, 'docs', 'onchain');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${env.QRVM_NETWORK || 'devnet'}.differential.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.table(byMethod);
  console.log(`${results.length} vectors, ${mismatched} mismatched; wrote ${path.relative(ROOT, file)}`);
  if (mismatched) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
