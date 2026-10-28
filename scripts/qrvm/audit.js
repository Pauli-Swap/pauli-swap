const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { loadEnv, Chain, readDeployment, artifact, link, strip, ROOT } = require('./lib');
const { QrvmAdapter, EvmAdapter, MAX } = require('./adapters');

/// On chain audit of a QRVM deployment of PauliSwap V2 and V3.
///
///   QRVM_ENV=.env.devnet npx hardhat run scripts/qrvm/audit.js
///
/// The same scenario runs twice: against the deployment named by QRVM_NETWORK
/// on its QIP-55 node, and against the unchanged 20 byte build on Hardhat's in
/// process EVM. Tokens are sorted into roles X < Y < Z on each chain, so every
/// amount, reserve, tick and fee figure is comparable one to one; anything
/// shaped by an address or by wall clock time is checked for its invariant
/// instead. Results land in docs/onchain/<network>.json.

const E18 = 10n ** 18n;
const DEADLINE = 1n << 32n;
const Q96 = 1n << 96n;
const SUPPLY = 10n ** 30n;

class Recorder {
  constructor() {
    this.rows = new Map();
    this.checks = [];
  }

  /// `cmp: false` keeps a value out of the cross chain comparison.
  set(chain, key, value, { cmp = true } = {}) {
    if (!this.rows.has(key)) this.rows.set(key, { key, cmp });
    this.rows.get(key)[chain] = value;
  }

  check(chain, name, ok, detail = '') {
    this.checks.push({ chain, name, ok: Boolean(ok), detail: String(detail) });
    if (!ok) console.log(`  FAIL [${chain}] ${name} ${detail}`);
  }
}

async function systemFor(a) {
  if (a.name === 'qrvm') {
    const d = a.deployment.contracts;
    return {
      wqrl: a.at('WQRL', d.WQRL),
      v2Factory: a.at('PauliV2Factory', d.PauliV2Factory),
      router: a.at('PauliV2Router02', d.PauliV2Router02),
      v3Factory: a.at('PauliV3Factory', d.PauliV3Factory),
      swapRouter: a.at('SwapRouter', d.SwapRouter),
      quoter: a.at('Quoter', d.Quoter),
      lens: a.at('PauliV3PoolLens', d.PauliV3PoolLens),
      npm: a.at('NonfungiblePositionManager', d.NonfungiblePositionManager),
      tickLens: a.at('TickLens', d.TickLens),
      migrator: a.at('V3Migrator', d.V3Migrator),
      oracle: d.Oracle,
      chunks: [d.PoolCodeChunkA, d.PoolCodeChunkB],
    };
  }
  const wqrl = await a.deploy('WQRL');
  const v2Factory = await a.deploy('PauliV2Factory', [a.deployer]);
  const router = await a.deploy('PauliV2Router02', [a.addr(v2Factory), a.addr(wqrl)]);
  const v3Factory = await a.deploy('PauliV3Factory');
  const swapRouter = await a.deploy('SwapRouter', [a.addr(v3Factory), a.addr(wqrl)]);
  const quoter = await a.deploy('Quoter', [a.addr(v3Factory), a.addr(wqrl)]);
  const descriptor = await a.deploy('PauliV3PositionDescriptor');
  const npm = await a.deploy('NonfungiblePositionManager', [a.addr(v3Factory), a.addr(wqrl), a.addr(descriptor)]);
  const tickLens = await a.deploy('TickLens');
  const migrator = await a.deploy('V3Migrator', [a.addr(v3Factory), a.addr(wqrl), a.addr(npm)]);
  return { wqrl, v2Factory, router, v3Factory, swapRouter, quoter, npm, tickLens, migrator };
}

async function fixtures(a, s) {
  const tokens = [];
  for (let i = 0; i < 3; i++) tokens.push(await a.deploy('TestSQRCTF1', [SUPPLY]));
  tokens.sort((p, q) => (a.sortKey(p) < a.sortKey(q) ? -1 : 1));
  const [X, Y, Z] = tokens;
  const D = await a.deploy('DeflatingSQRCTF1', [SUPPLY]);
  const caller = await a.deploy('PauliV3PoolCaller');
  const borrower = await a.deploy('PauliV2FlashBorrower');
  const reentrancy = await a.deploy('PauliV2ReentrancyProbe');
  const ndc = await a.deploy('NoDelegateCallProbe');
  const receiver = await a.deploy('SQRCTN1ReceiverProbe');
  for (const t of [X, Y, Z, D]) {
    for (const spender of [s.router, s.swapRouter, caller, borrower, s.npm]) {
      await a.send(t, 'approve', [a.addr(spender), MAX]);
    }
  }
  // The devnet deployer lives on a 100 QRL faucet drip.
  await a.send(s.wqrl, 'deposit', [], { value: 20n * E18 });
  for (const spender of [s.router, s.swapRouter, caller, s.npm]) await a.send(s.wqrl, 'approve', [a.addr(spender), MAX]);
  return { X, Y, Z, D, caller, borrower, reentrancy, ndc, receiver };
}

const roleOf = (a, f, s) => (addr) => {
  for (const [name, c] of Object.entries({ X: f.X, Y: f.Y, Z: f.Z, D: f.D, WQRL: s.wqrl })) {
    if (a.sameAddress(c, addr)) return name;
  }
  return 'other';
};

async function reservesByRole(a, pair, role, roles) {
  const [r0, r1] = await a.call(pair, 'getReserves');
  const t0 = role(await a.call(pair, 'token0'));
  const [first, second] = roles;
  return t0 === first ? { [first]: r0, [second]: r1 } : { [first]: r1, [second]: r0 };
}

async function v2(a, s, f, R) {
  const c = a.name;
  const role = roleOf(a, f, s);
  const me = a.deployer;

  R.check(c, 'router.factory() is the V2 factory', a.sameAddress(await a.call(s.router, 'factory'), s.v2Factory));
  R.check(c, 'router.WQRL() is WQRL', a.sameAddress(await a.call(s.router, 'WQRL'), s.wqrl));

  // The factory outlives a run on a persistent deployment; start from the
  // state a fresh one has.
  await a.send(s.v2Factory, 'setFeeTo', [a.zero]);
  const pairsBefore = await a.call(s.v2Factory, 'allPairsLength');

  // Liquidity X/Y
  const addXY = await a.call(s.router, 'addLiquidity', [a.addr(f.X), a.addr(f.Y), 10n * E18, 40n * E18, 0n, 0n, me, DEADLINE]);
  await a.send(s.router, 'addLiquidity', [a.addr(f.X), a.addr(f.Y), 10n * E18, 40n * E18, 0n, 0n, me, DEADLINE], { tag: 'v2.addLiquidity(new pair)' });
  R.set(c, 'v2.addLiquidity.XY', addXY);
  const pairAddr = await a.call(s.v2Factory, 'getPair', [a.addr(f.X), a.addr(f.Y)]);
  const pairRev = await a.call(s.v2Factory, 'getPair', [a.addr(f.Y), a.addr(f.X)]);
  R.check(c, 'getPair is symmetric and non zero', a.sameAddress(pairAddr, pairRev) && strip(pairAddr) !== '0'.repeat(strip(pairAddr).length));
  R.set(c, 'v2.allPairsLength delta', (await a.call(s.v2Factory, 'allPairsLength')) - pairsBefore);
  const pair = a.at('PauliV2Pair', pairAddr);

  const codeHash = await a.call(s.v2Factory, 'pairCodeHash');
  const [t0, t1] = [await a.call(pair, 'token0'), await a.call(pair, 'token1')];
  const salt = a.keccak('0x' + strip(t0) + strip(t1));
  R.check(c, 'pair address equals the off chain CREATE2 formula', a.sameAddress(a.create2(s.v2Factory, salt, codeHash), pairAddr), pairAddr);
  R.check(c, 'pairCodeHash equals the local pair artifact', codeHash === a.keccak(a.name === 'qrvm' ? artifact('PauliV2Pair').bytecode : a.art('PauliV2Pair').bytecode));

  R.set(c, 'v2.lp.totalSupply', await a.call(pair, 'totalSupply'));
  R.set(c, 'v2.lp.balanceOf(me)', await a.call(pair, 'balanceOf', [me]));
  R.set(c, 'v2.lp.balanceOf(zero) [MINIMUM_LIQUIDITY]', await a.call(pair, 'balanceOf', [a.zero]));
  R.set(c, 'v2.reserves.XY', await reservesByRole(a, pair, role, ['X', 'Y']));
  R.set(c, 'v2.lp.name/symbol/decimals', [await a.call(pair, 'name'), await a.call(pair, 'symbol'), await a.call(pair, 'decimals')]);

  // Swaps
  R.set(c, 'v2.getAmountsOut(1e18,[X,Y])', await a.call(s.router, 'getAmountsOut', [E18, [a.addr(f.X), a.addr(f.Y)]]));
  const swap1 = await a.call(s.router, 'swapExactTokensForTokens', [E18, 0n, [a.addr(f.X), a.addr(f.Y)], me, DEADLINE]);
  await a.send(s.router, 'swapExactTokensForTokens', [E18, 0n, [a.addr(f.X), a.addr(f.Y)], me, DEADLINE], { tag: 'v2.swapExactTokensForTokens' });
  R.set(c, 'v2.swapExactTokensForTokens(1e18,[X,Y])', swap1);
  R.set(c, 'v2.getAmountsIn(1e18,[Y,X])', await a.call(s.router, 'getAmountsIn', [E18, [a.addr(f.Y), a.addr(f.X)]]));
  R.set(c, 'v2.swapTokensForExactTokens(1e18,[Y,X])', await a.call(s.router, 'swapTokensForExactTokens', [E18, MAX, [a.addr(f.Y), a.addr(f.X)], me, DEADLINE]));
  await a.send(s.router, 'swapTokensForExactTokens', [E18, MAX, [a.addr(f.Y), a.addr(f.X)], me, DEADLINE]);
  R.set(c, 'v2.reserves.XY after swaps', await reservesByRole(a, pair, role, ['X', 'Y']));
  R.set(c, 'v2.kLast (fee off)', await a.call(pair, 'kLast'));

  // Multi hop X -> Y -> Z
  await a.send(s.router, 'addLiquidity', [a.addr(f.Y), a.addr(f.Z), 50n * E18, 50n * E18, 0n, 0n, me, DEADLINE]);
  R.set(c, 'v2.swapExactTokensForTokens(1e18,[X,Y,Z])', await a.call(s.router, 'swapExactTokensForTokens', [E18, 0n, [a.addr(f.X), a.addr(f.Y), a.addr(f.Z)], me, DEADLINE]));
  await a.send(s.router, 'swapExactTokensForTokens', [E18, 0n, [a.addr(f.X), a.addr(f.Y), a.addr(f.Z)], me, DEADLINE], { tag: 'v2.swap 2 hops' });

  // Native QRL through WQRL
  R.set(c, 'v2.addLiquidityQRL(X 10e18, 5 QRL)', await a.call(s.router, 'addLiquidityQRL', [a.addr(f.X), 10n * E18, 0n, 0n, me, DEADLINE], { value: 5n * E18 }));
  await a.send(s.router, 'addLiquidityQRL', [a.addr(f.X), 10n * E18, 0n, 0n, me, DEADLINE], { value: 5n * E18, tag: 'v2.addLiquidityQRL' });
  R.set(c, 'v2.swapExactQRLForTokens(1 QRL,[WQRL,X])', await a.call(s.router, 'swapExactQRLForTokens', [0n, [a.addr(s.wqrl), a.addr(f.X)], me, DEADLINE], { value: E18 }));
  await a.send(s.router, 'swapExactQRLForTokens', [0n, [a.addr(s.wqrl), a.addr(f.X)], me, DEADLINE], { value: E18 });
  R.set(c, 'v2.swapExactTokensForQRL(1e18,[X,WQRL])', await a.call(s.router, 'swapExactTokensForQRL', [E18, 0n, [a.addr(f.X), a.addr(s.wqrl)], me, DEADLINE]));
  await a.send(s.router, 'swapExactTokensForQRL', [E18, 0n, [a.addr(f.X), a.addr(s.wqrl)], me, DEADLINE]);
  R.set(c, 'v2.router native balance after QRL swaps', await a.nativeBalance(s.router));
  const qrlPair = a.at('PauliV2Pair', await a.call(s.v2Factory, 'getPair', [a.addr(f.X), a.addr(s.wqrl)]));
  const qrlLp = await a.call(qrlPair, 'balanceOf', [me]);
  await a.send(qrlPair, 'approve', [a.addr(s.router), MAX]);
  R.set(c, 'v2.lp allowance(me, router) after approve(max)', await a.call(qrlPair, 'allowance', [me, a.addr(s.router)]));
  R.set(c, 'v2.removeLiquidityQRL(half)', await a.call(s.router, 'removeLiquidityQRL', [a.addr(f.X), qrlLp / 2n, 0n, 0n, me, DEADLINE]));
  await a.send(s.router, 'removeLiquidityQRL', [a.addr(f.X), qrlLp / 2n, 0n, 0n, me, DEADLINE]);
  R.set(c, 'v2.reserves.X/WQRL', await reservesByRole(a, qrlPair, role, ['X', 'WQRL']));

  // Fee on transfer token
  await a.send(s.router, 'addLiquidityQRL', [a.addr(f.D), 10n * E18, 0n, 0n, me, DEADLINE], { value: 5n * E18 });
  const dPair = a.at('PauliV2Pair', await a.call(s.v2Factory, 'getPair', [a.addr(f.D), a.addr(s.wqrl)]));
  R.set(c, 'v2.reserves.D/WQRL', await reservesByRole(a, dPair, role, ['D', 'WQRL']));
  const dBefore = await a.call(s.wqrl, 'balanceOf', [me]);
  await a.send(s.router, 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [E18, 0n, [a.addr(f.D), a.addr(s.wqrl)], me, DEADLINE]);
  R.set(c, 'v2.FoT swap D->WQRL received', (await a.call(s.wqrl, 'balanceOf', [me])) - dBefore);
  const dBal = await a.call(f.D, 'balanceOf', [me]);
  await a.send(s.router, 'swapExactQRLForTokensSupportingFeeOnTransferTokens', [0n, [a.addr(s.wqrl), a.addr(f.D)], me, DEADLINE], { value: E18 / 10n });
  R.set(c, 'v2.FoT swap QRL->D received', (await a.call(f.D, 'balanceOf', [me])) - dBal);
  const dLp = await a.call(dPair, 'balanceOf', [me]);
  await a.send(dPair, 'approve', [a.addr(s.router), MAX]);
  const dBal2 = await a.call(f.D, 'balanceOf', [me]);
  await a.send(s.router, 'removeLiquidityQRLSupportingFeeOnTransferTokens', [a.addr(f.D), dLp / 2n, 0n, 0n, me, DEADLINE]);
  R.set(c, 'v2.FoT removeLiquidityQRL D received', (await a.call(f.D, 'balanceOf', [me])) - dBal2);

  // Flash swap and the K invariant
  await a.send(f.borrower, 'setRepayShort', [true]);
  R.set(c, 'v2.flash short repay reverts with', await a.revertReason(f.borrower, 'flashSwap', [pairAddr, E18, 0n]));
  await a.send(f.borrower, 'setRepayShort', [false]);
  const yBefore = await a.call(f.Y, 'balanceOf', [me]);
  await a.send(f.borrower, 'flashSwap', [pairAddr, E18, 0n], { tag: 'v2.flash swap' });
  R.set(c, 'v2.flash swap: Y paid by payer', yBefore - (await a.call(f.Y, 'balanceOf', [me])));
  R.set(c, 'v2.flash swap: X held by borrower', await a.call(f.X, 'balanceOf', [a.addr(f.borrower)]));
  R.set(c, 'v2.reentrancy into swap reverts with', await a.revertReason(f.reentrancy, 'attack', [pairAddr]));

  // Protocol fee switch
  await a.send(s.v2Factory, 'setFeeTo', [a.addr(f.ndc)]);
  await a.send(s.router, 'swapExactTokensForTokens', [5n * E18, 0n, [a.addr(f.X), a.addr(f.Y)], me, DEADLINE]);
  await a.send(s.router, 'addLiquidity', [a.addr(f.X), a.addr(f.Y), E18, 4n * E18, 0n, 0n, me, DEADLINE]);
  R.set(c, 'v2.protocol fee LP minted to feeTo', await a.call(pair, 'balanceOf', [a.addr(f.ndc)]));
  R.set(c, 'v2.kLast (fee on)', await a.call(pair, 'kLast'));
  await a.send(s.v2Factory, 'setFeeTo', [a.zero]);

  // Reverts
  R.set(c, 'v2.revert: expired deadline', await a.revertReason(s.router, 'swapExactTokensForTokens', [E18, 0n, [a.addr(f.X), a.addr(f.Y)], me, 0n]));
  R.set(c, 'v2.revert: min out', await a.revertReason(s.router, 'swapExactTokensForTokens', [E18, MAX, [a.addr(f.X), a.addr(f.Y)], me, DEADLINE]));
  R.set(c, 'v2.revert: identical tokens', await a.revertReason(s.v2Factory, 'createPair', [a.addr(f.X), a.addr(f.X)]));
  R.set(c, 'v2.revert: pair exists', await a.revertReason(s.v2Factory, 'createPair', [a.addr(f.Y), a.addr(f.X)]));
  R.set(c, 'v2.revert: missing pair path', await a.revertReason(s.router, 'getAmountsOut', [E18, [a.addr(f.Z), a.addr(f.D)]]), { cmp: false });

  // Exit
  const lp = await a.call(pair, 'balanceOf', [me]);
  await a.send(pair, 'approve', [a.addr(s.router), MAX]);
  R.set(c, 'v2.removeLiquidity(all XY LP)', await a.call(s.router, 'removeLiquidity', [a.addr(f.X), a.addr(f.Y), lp, 0n, 0n, me, DEADLINE]));
  await a.send(s.router, 'removeLiquidity', [a.addr(f.X), a.addr(f.Y), lp, 0n, 0n, me, DEADLINE], { tag: 'v2.removeLiquidity' });
  R.set(c, 'v2.reserves.XY after exit', await reservesByRole(a, pair, role, ['X', 'Y']));
  const [, , ts] = await a.call(pair, 'getReserves');
  R.set(c, 'v2.blockTimestampLast', ts, { cmp: false });
  const p0 = await a.call(pair, 'price0CumulativeLast');
  R.set(c, 'v2.price0CumulativeLast', p0, { cmp: false });
  R.check(c, 'price0CumulativeLast advanced', p0 > 0n, p0);
}

const int24hex = (v) => ((BigInt(v) + (1n << 24n)) % (1n << 24n)).toString(16).padStart(6, '0');

async function v3(a, s, f, R) {
  const c = a.name;
  const me = a.deployer;
  const fee = 3000;

  R.set(c, 'v3.feeAmountTickSpacing(500,3000,10000)', [await a.call(s.v3Factory, 'feeAmountTickSpacing', [500]), await a.call(s.v3Factory, 'feeAmountTickSpacing', [3000]), await a.call(s.v3Factory, 'feeAmountTickSpacing', [10000])]);
  R.set(c, 'v3.factory owner is deployer', a.sameAddress(await a.call(s.v3Factory, 'owner'), me));

  await a.send(s.v3Factory, 'createPool', [a.addr(f.X), a.addr(f.Y), fee], { tag: 'v3.createPool' });
  const poolAddr = await a.call(s.v3Factory, 'getPool', [a.addr(f.X), a.addr(f.Y), fee]);
  R.check(c, 'getPool is symmetric', a.sameAddress(poolAddr, await a.call(s.v3Factory, 'getPool', [a.addr(f.Y), a.addr(f.X), fee])));
  const pool = a.at('PauliV3Pool', poolAddr);
  const salt = a.keccak(a.encode(['address', 'address', 'uint24'], [a.addr(f.X), a.addr(f.Y), fee]));
  const poolCodeHash = a.name === 'qrvm'
    ? await a.call(s.v3Factory, 'poolCodeHash')
    : a.keccak(a.art('PauliV3Pool').bytecode);
  R.check(c, 'pool address equals the off chain CREATE2 formula', a.sameAddress(a.create2(s.v3Factory, salt, poolCodeHash), poolAddr), poolAddr);
  R.set(c, 'v3.pool immutables (fee, tickSpacing, maxLiquidityPerTick)', [await a.call(pool, 'fee'), await a.call(pool, 'tickSpacing'), await a.call(pool, 'maxLiquidityPerTick')]);
  R.check(c, 'pool token0/token1 are X/Y', a.sameAddress(await a.call(pool, 'token0'), f.X) && a.sameAddress(await a.call(pool, 'token1'), f.Y));

  // Price 1:1.0201 (tick 199) so the math is not trivially symmetric.
  const sqrtP = 80_016_521_857_016_597_127_997_947_904n;
  await a.send(pool, 'initialize', [sqrtP], { tag: 'v3.initialize' });
  R.set(c, 'v3.slot0 after initialize', await a.call(pool, 'slot0'));
  R.set(c, 'v3.revert: initialize twice', await a.revertReason(pool, 'initialize', [sqrtP]));

  const mintNarrow = await a.call(f.caller, 'mint', [poolAddr, me, -600, 600, 10n ** 21n]);
  await a.send(f.caller, 'mint', [poolAddr, me, -600, 600, 10n ** 21n], { tag: 'v3.mint (new ticks)' });
  R.set(c, 'v3.mint(-600,600,1e21)', mintNarrow);
  R.set(c, 'v3.mint(full range,1e20)', await a.call(f.caller, 'mint', [poolAddr, me, -887220, 887220, 10n ** 20n]));
  await a.send(f.caller, 'mint', [poolAddr, me, -887220, 887220, 10n ** 20n]);
  R.set(c, 'v3.liquidity', await a.call(pool, 'liquidity'));
  R.set(c, 'v3.ticks(-600)', (await a.call(pool, 'ticks', [-600])).filter((_, i) => i < 4 || i === 7));
  R.set(c, 'v3.ticks(600).liquidityNet', (await a.call(pool, 'ticks', [600]))[1]);
  R.set(c, 'v3.tickBitmap(-1), tickBitmap(0)', [await a.call(pool, 'tickBitmap', [-1]), await a.call(pool, 'tickBitmap', [0])]);
  const posKey = a.name === 'qrvm'
    ? a.keccak('0x' + strip(me) + int24hex(-600) + int24hex(600))
    : a.ethers.solidityPackedKeccak256(['address', 'int24', 'int24'], [me, -600, 600]);
  R.set(c, 'v3.positions(me,-600,600)', await a.call(pool, 'positions', [posKey]));
  R.set(c, 'v3.revert: mint tickLower >= tickUpper', await a.revertReason(f.caller, 'mint', [poolAddr, me, 600, -600, E18]));

  // Quotes against swaps
  const params = (tokenIn, tokenOut, amountIn) => [a.addr(tokenIn), a.addr(tokenOut), fee, me, DEADLINE, amountIn, 0n, 0n];
  const q1 = await a.call(s.quoter, 'quoteExactInputSingle', [a.addr(f.X), a.addr(f.Y), fee, 10n ** 19n, 0n]);
  const s1 = await a.call(s.swapRouter, 'exactInputSingle', [params(f.X, f.Y, 10n ** 19n)]);
  await a.send(s.swapRouter, 'exactInputSingle', [params(f.X, f.Y, 10n ** 19n)], { tag: 'v3.exactInputSingle' });
  R.set(c, 'v3.quoteExactInputSingle(X->Y,1e19)', q1);
  R.set(c, 'v3.exactInputSingle(X->Y,1e19)', s1);
  R.check(c, 'quoter matches exactInputSingle', q1 === s1, `${q1} vs ${s1}`);
  R.set(c, 'v3.slot0 after X->Y', await a.call(pool, 'slot0'));

  const outParams = [a.addr(f.Y), a.addr(f.X), fee, me, DEADLINE, 5n * 10n ** 18n, MAX, 0n];
  const q2 = await a.call(s.quoter, 'quoteExactOutputSingle', [a.addr(f.Y), a.addr(f.X), fee, 5n * 10n ** 18n, 0n]);
  const s2 = await a.call(s.swapRouter, 'exactOutputSingle', [outParams]);
  await a.send(s.swapRouter, 'exactOutputSingle', [outParams]);
  R.set(c, 'v3.exactOutputSingle(Y->X,out 5e18) amountIn', s2);
  R.check(c, 'quoter matches exactOutputSingle', q2 === s2, `${q2} vs ${s2}`);

  // Multi hop X -> Y -> Z through two pools, exercising Path and BytesLib
  await a.send(s.v3Factory, 'createPool', [a.addr(f.Y), a.addr(f.Z), fee]);
  const poolYZ = a.at('PauliV3Pool', await a.call(s.v3Factory, 'getPool', [a.addr(f.Y), a.addr(f.Z), fee]));
  await a.send(poolYZ, 'initialize', [Q96]);
  await a.send(f.caller, 'mint', [a.addr(poolYZ), me, -1200, 1200, 10n ** 21n]);
  const pathXYZ = a.path([f.X, f.Y, f.Z], [fee, fee]);
  R.set(c, 'v3.path length (X,Y,Z)', BigInt((strip(pathXYZ).length) / 2), { cmp: false });
  const q3 = await a.call(s.quoter, 'quoteExactInput', [pathXYZ, 10n ** 18n]);
  const s3 = await a.call(s.swapRouter, 'exactInput', [[pathXYZ, me, DEADLINE, 10n ** 18n, 0n]]);
  await a.send(s.swapRouter, 'exactInput', [[pathXYZ, me, DEADLINE, 10n ** 18n, 0n]], { tag: 'v3.exactInput 2 hops' });
  R.set(c, 'v3.exactInput(X->Y->Z,1e18)', s3);
  R.check(c, 'quoter matches exactInput (2 hops)', q3 === s3, `${q3} vs ${s3}`);
  const pathZYX = a.path([f.Z, f.Y, f.X], [fee, fee]);
  const q4 = await a.call(s.quoter, 'quoteExactOutput', [pathZYX, 10n ** 18n]);
  const s4 = await a.call(s.swapRouter, 'exactOutput', [[pathZYX, me, DEADLINE, 10n ** 18n, MAX]]);
  await a.send(s.swapRouter, 'exactOutput', [[pathZYX, me, DEADLINE, 10n ** 18n, MAX]]);
  R.set(c, 'v3.exactOutput(out 1e18 X via Y from Z) amountIn', s4);
  R.check(c, 'quoter matches exactOutput (2 hops)', q4 === s4, `${q4} vs ${s4}`);

  // Native QRL in, and out through multicall + unwrap
  await a.send(s.v3Factory, 'createPool', [a.addr(s.wqrl), a.addr(f.X), fee]);
  const poolQ = a.at('PauliV3Pool', await a.call(s.v3Factory, 'getPool', [a.addr(s.wqrl), a.addr(f.X), fee]));
  await a.send(poolQ, 'initialize', [Q96]);
  await a.send(f.caller, 'mint', [a.addr(poolQ), me, -6000, 6000, 2n * 10n ** 19n]);
  const xBefore = await a.call(f.X, 'balanceOf', [me]);
  await a.send(s.swapRouter, 'exactInputSingle', [params(s.wqrl, f.X, E18)], { value: E18 });
  R.set(c, 'v3.exactInputSingle(QRL->X,1 QRL) received', (await a.call(f.X, 'balanceOf', [me])) - xBefore, { cmp: false });
  R.set(c, 'v3.router native balance after QRL in', await a.nativeBalance(s.swapRouter));
  const swapData = s.swapRouter.interface
    ? s.swapRouter.interface.encodeFunctionData('exactInputSingle', [[a.addr(f.X), a.addr(s.wqrl), fee, a.addr(s.swapRouter), DEADLINE, E18, 0n, 0n]])
    : s.swapRouter.methods.exactInputSingle([a.addr(f.X), a.addr(s.wqrl), fee, a.addr(s.swapRouter), DEADLINE, E18, 0n, 0n]).encodeABI();
  const unwrapData = s.swapRouter.interface
    ? s.swapRouter.interface.encodeFunctionData('unwrapWQRL9', [0n, me])
    : s.swapRouter.methods.unwrapWQRL9(0n, me).encodeABI();
  const nativeBefore = await a.nativeBalance(me);
  await a.send(s.swapRouter, 'multicall', [[swapData, unwrapData]], { tag: 'v3.multicall swap+unwrap' });
  R.check(c, 'multicall swap + unwrapWQRL9 paid native QRL out', (await a.nativeBalance(me)) > nativeBefore - 10n ** 17n);
  R.set(c, 'v3.router WQRL balance after unwrap', await a.call(s.wqrl, 'balanceOf', [a.addr(s.swapRouter)]));
  const badUnwrap = s.swapRouter.interface
    ? s.swapRouter.interface.encodeFunctionData('unwrapWQRL9', [MAX, me])
    : s.swapRouter.methods.unwrapWQRL9(MAX, me).encodeABI();
  R.set(c, 'v3.revert: multicall bubbles reason', await a.revertReason(s.swapRouter, 'multicall', [[badUnwrap]]));

  // Flash, protocol fee, burn and collect
  const fees0 = await a.call(pool, 'feeGrowthGlobal0X128');
  await a.send(f.caller, 'flash', [poolAddr, a.addr(f.caller), 10n ** 18n, 2n * 10n ** 18n], { tag: 'v3.flash' });
  R.set(c, 'v3.feeGrowthGlobal0X128 delta from flash', (await a.call(pool, 'feeGrowthGlobal0X128')) - fees0);
  R.set(c, 'v3.revert: flash without liquidity', await a.revertReason(f.caller, 'flash', [poolAddr, a.addr(f.caller), 10n ** 30n, 0n]));
  await a.send(pool, 'setFeeProtocol', [4, 4]);
  await a.send(s.swapRouter, 'exactInputSingle', [params(f.Y, f.X, 10n ** 19n)]);
  R.set(c, 'v3.protocolFees after swap', await a.call(pool, 'protocolFees'));
  R.set(c, 'v3.collectProtocol', await a.call(pool, 'collectProtocol', [me, MAX >> 128n, MAX >> 128n]));
  await a.send(pool, 'collectProtocol', [me, MAX >> 128n, MAX >> 128n]);
  R.set(c, 'v3.burn(-600,600,5e20)', await a.call(pool, 'burn', [-600, 600, 5n * 10n ** 20n]));
  await a.send(pool, 'burn', [-600, 600, 5n * 10n ** 20n], { tag: 'v3.burn' });
  R.set(c, 'v3.positions after burn', await a.call(pool, 'positions', [posKey]));
  R.set(c, 'v3.collect(all)', await a.call(pool, 'collect', [me, -600, 600, MAX >> 128n, MAX >> 128n]));
  await a.send(pool, 'collect', [me, -600, 600, MAX >> 128n, MAX >> 128n], { tag: 'v3.collect' });
  R.set(c, 'v3.revert: swap amount 0', await a.revertReason(f.caller, 'swap', [poolAddr, me, true, 0n, 4295128740n]));
  R.set(c, 'v3.revert: swap price limit', await a.revertReason(f.caller, 'swap', [poolAddr, me, true, E18, (1n << 160n) - 1n]));
  R.set(c, 'v3.revert: setFeeProtocol out of range', await a.revertReason(pool, 'setFeeProtocol', [3, 3]));

  // Oracle through the linked library
  await a.send(pool, 'increaseObservationCardinalityNext', [10], { tag: 'v3.grow observations (linked Oracle)' });
  R.set(c, 'v3.slot0.observationCardinalityNext', (await a.call(pool, 'slot0'))[4]);
  const obs = await a.call(pool, 'observe', [[0]]);
  R.check(c, 'observe([0]) answers', Array.isArray(obs) && obs[0].length === 1);
  R.set(c, 'v3.revert: observe older than history', await a.revertReason(pool, 'observe', [[1n << 31n]]));
  const snap = a.name === 'qrvm'
    ? await a.call(s.lens, 'snapshotCumulativesInside', [poolAddr, -600, 600])
    : await a.call(pool, 'snapshotCumulativesInside', [-600, 600]);
  R.set(c, 'v3.snapshotCumulativesInside(-600,600)', snap, { cmp: false });
  R.check(c, 'snapshotCumulativesInside answers', Array.isArray(snap) && snap.length === 3);
  R.set(c, 'v3.revert: snapshot of uninitialized ticks', a.name === 'qrvm'
    ? await a.revertReason(s.lens, 'snapshotCumulativesInside', [poolAddr, -60, 60])
    : await a.revertReason(pool, 'snapshotCumulativesInside', [-60, 60]));
  R.set(c, 'v3.noDelegateCall blocks delegated swap', !(await a.call(f.ndc, 'delegateSwap', [poolAddr, me, true, E18, 4295128740n])));
}

/// Position NFTs: NonfungiblePositionManager, its descriptor, TickLens and
/// V3Migrator. Token IDs and supply are read as deltas because the deployment
/// outlives a run; everything else runs on pools of this run's fresh tokens.
async function positions(a, s, f, R) {
  const c = a.name;
  const me = a.deployer;
  const fee = 500;
  const role = roleOf(a, f, s);
  const supply0 = await a.call(s.npm, 'totalSupply');
  const owned0 = await a.call(s.npm, 'balanceOf', [me]);

  R.check(c, 'npm.factory() and npm.WQRL9() are wired', a.sameAddress(await a.call(s.npm, 'factory'), s.v3Factory) && a.sameAddress(await a.call(s.npm, 'WQRL9'), s.wqrl));
  R.set(c, 'npm.name/symbol', [await a.call(s.npm, 'name'), await a.call(s.npm, 'symbol')]);

  // Pool X/Z at 0.05%, created and initialized through the position manager.
  const sqrtP = 80_016_521_857_016_597_127_997_947_904n;
  R.set(c, 'npm.revert: createAndInitialize with unsorted tokens', await a.revertReason(s.npm, 'createAndInitializePoolIfNecessary', [a.addr(f.Z), a.addr(f.X), fee, sqrtP]));
  await a.send(s.npm, 'createAndInitializePoolIfNecessary', [a.addr(f.X), a.addr(f.Z), fee, sqrtP], { tag: 'npm.createAndInitializePoolIfNecessary' });
  await a.send(s.npm, 'createAndInitializePoolIfNecessary', [a.addr(f.X), a.addr(f.Z), fee, sqrtP * 2n]);
  const poolAddr = await a.call(s.v3Factory, 'getPool', [a.addr(f.X), a.addr(f.Z), fee]);
  const pool = a.at('PauliV3Pool', poolAddr);
  R.set(c, 'npm.pool slot0 after create (second call is a no-op)', (await a.call(pool, 'slot0')).slice(0, 2));

  const mintParams = (lower, upper, amount) => [[a.addr(f.X), a.addr(f.Z), fee, lower, upper, amount, amount, 0n, 0n, me, DEADLINE]];
  const minted = await a.call(s.npm, 'mint', mintParams(-1000, 1000, 5n * E18));
  await a.send(s.npm, 'mint', mintParams(-1000, 1000, 5n * E18), { tag: 'npm.mint (new position)' });
  const id = minted[0];
  R.set(c, 'npm.mint(-1000,1000,5e18 each) liquidity,amount0,amount1', minted.slice(1));
  R.set(c, 'npm.tokenId', id, { cmp: false });
  R.set(c, 'npm.totalSupply delta after mint', (await a.call(s.npm, 'totalSupply')) - supply0);
  R.check(c, 'npm.ownerOf(tokenId) is the minter', a.sameAddress(await a.call(s.npm, 'ownerOf', [id]), me));
  R.check(c, 'npm.tokenOfOwnerByIndex(last) is the new token', (await a.call(s.npm, 'tokenOfOwnerByIndex', [me, owned0])) === id);
  const pos = async () => {
    const p = await a.call(s.npm, 'positions', [id]);
    return { nonce: p[0], operator: a.sameAddress(p[1], a.zero) ? 'zero' : 'set', tokens: [role(p[2]), role(p[3])], rest: p.slice(4) };
  };
  R.set(c, 'npm.positions(tokenId) after mint', await pos());
  const npmKey = a.name === 'qrvm'
    ? a.keccak('0x' + strip(a.addr(s.npm)) + int24hex(-1000) + int24hex(1000))
    : a.ethers.solidityPackedKeccak256(['address', 'int24', 'int24'], [a.addr(s.npm), -1000, 1000]);
  R.check(c, 'core position held by the NPM has the NFT liquidity', (await a.call(pool, 'positions', [npmKey]))[0] === minted[1]);

  // Fees through the swap router, then increase, collect, decrease.
  const swap = (tokenIn, tokenOut, amountIn) => [[a.addr(tokenIn), a.addr(tokenOut), fee, me, DEADLINE, amountIn, 0n, 0n]];
  await a.send(s.swapRouter, 'exactInputSingle', swap(f.X, f.Z, E18));
  await a.send(s.swapRouter, 'exactInputSingle', swap(f.Z, f.X, 2n * E18));
  const inc = [[id, E18, E18, 0n, 0n, DEADLINE]];
  R.set(c, 'npm.increaseLiquidity(1e18 each)', await a.call(s.npm, 'increaseLiquidity', inc));
  await a.send(s.npm, 'increaseLiquidity', inc, { tag: 'npm.increaseLiquidity' });
  R.set(c, 'npm.positions after increase (fees folded into owed)', await pos());
  const collectAll = (to) => [[id, to, MAX >> 128n, MAX >> 128n]];
  R.set(c, 'npm.collect(fees only)', await a.call(s.npm, 'collect', collectAll(me)));
  await a.send(s.npm, 'collect', collectAll(me), { tag: 'npm.collect' });
  const half = (await a.call(s.npm, 'positions', [id]))[7] / 2n;
  const dec = [[id, half, 0n, 0n, DEADLINE]];
  R.set(c, 'npm.decreaseLiquidity(half)', await a.call(s.npm, 'decreaseLiquidity', dec));
  await a.send(s.npm, 'decreaseLiquidity', dec, { tag: 'npm.decreaseLiquidity' });
  R.set(c, 'npm.positions after decrease', await pos());
  R.set(c, 'npm.revert: slippage on decrease', await a.revertReason(s.npm, 'decreaseLiquidity', [[id, 1n, MAX, 0n, DEADLINE]]));
  R.set(c, 'npm.revert: burn before clearing', await a.revertReason(s.npm, 'burn', [id]));

  R.set(c, 'ticklens.getPopulatedTicksInWord(-1), (0)', [
    await a.call(s.tickLens, 'getPopulatedTicksInWord', [poolAddr, -1]),
    await a.call(s.tickLens, 'getPopulatedTicksInWord', [poolAddr, 0]),
  ]);

  // Metadata. The name has no addresses in it, so it compares across chains;
  // the description must carry the pool address in this chain's width.
  const uri = await a.call(s.npm, 'tokenURI', [id]);
  const json = JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
  R.set(c, 'npm.tokenURI name', json.name);
  R.check(c, 'npm.tokenURI description carries the pool address', json.description.includes('Pool Address: Q' + strip(poolAddr).toLowerCase()), json.description.slice(0, 160));
  R.set(c, 'npm.revert: tokenURI of a missing token', await a.revertReason(s.npm, 'tokenURI', [id + 1000n]));

  // Authorization, approvals and SQRC-TN1 receiver handling. A second NFT goes
  // to the probe contract so the deployer is no longer its owner.
  const id2 = (await a.call(s.npm, 'mint', mintParams(-100, 100, E18)))[0];
  await a.send(s.npm, 'mint', mintParams(-100, 100, E18));
  await a.send(s.npm, 'approve', [a.addr(f.receiver), id2]);
  R.check(c, 'npm.positions().operator reads the SQRC-TN1 approval', a.sameAddress((await a.call(s.npm, 'positions', [id2]))[1], f.receiver));
  await a.send(f.receiver, 'setReject', [true]);
  R.set(c, 'npm.revert: safeTransferFrom to a rejecting receiver', await a.revertReason(s.npm, 'safeTransferFrom(address,address,uint256)', [me, a.addr(f.receiver), id2]), { cmp: false });
  R.check(c, 'rejected safe transfer leaves the owner unchanged', a.sameAddress(await a.call(s.npm, 'ownerOf', [id2]), me));
  await a.send(f.receiver, 'setReject', [false]);
  await a.send(s.npm, 'safeTransferFrom(address,address,uint256)', [me, a.addr(f.receiver), id2], { tag: 'npm.safeTransferFrom to contract' });
  R.check(c, 'safe transfer to an accepting receiver moves the token', a.sameAddress(await a.call(s.npm, 'ownerOf', [id2]), f.receiver));
  R.check(c, 'transfer clears the single token approval', a.sameAddress((await a.call(s.npm, 'positions', [id2]))[1], a.zero));
  const dec2 = [[id2, 1n, 0n, 0n, DEADLINE]];
  R.set(c, 'npm.revert: decrease by a non owner', await a.revertReason(s.npm, 'decreaseLiquidity', dec2));
  R.set(c, 'npm.revert: multicall bubbles Not approved', await a.revertReason(s.npm, 'multicall', [[a.encodeCall(s.npm, 'decreaseLiquidity', dec2)]]));
  R.set(c, 'npm.revert: transferFrom by a non owner (custom error)', await a.revertReason(s.npm, 'transferFrom', [a.addr(f.receiver), me, id2]));
  R.set(c, 'npm.revert: custom error inside multicall', await a.revertReason(s.npm, 'multicall', [[a.encodeCall(s.npm, 'transferFrom', [a.addr(f.receiver), me, id2])]]));
  R.set(c, 'npm.revert: forged mint callback', await a.revertReason(s.npm, 'pauliV3MintCallback', [1n, 1n, a.encode(['address', 'address', 'uint24', 'address'], [a.addr(f.X), a.addr(f.Z), fee, me])]));

  // Exit the first position completely and burn it.
  const rest = (await a.call(s.npm, 'positions', [id]))[7];
  await a.send(s.npm, 'decreaseLiquidity', [[id, rest, 0n, 0n, DEADLINE]]);
  R.set(c, 'npm.collect(after full decrease)', await a.call(s.npm, 'collect', collectAll(me)));
  await a.send(s.npm, 'collect', collectAll(me));
  await a.send(s.npm, 'burn', [id], { tag: 'npm.burn' });
  R.set(c, 'npm.revert: positions of a burned token', await a.revertReason(s.npm, 'positions', [id]));
  R.set(c, 'npm.totalSupply delta at end', (await a.call(s.npm, 'totalSupply')) - supply0);
  R.set(c, 'npm.pool liquidity at end', await a.call(pool, 'liquidity'));

  // Native QRL: mint into the WQRL/X pool from v3() in one multicall, refund the rest.
  const [q0, q1] = a.sortKey(s.wqrl) < a.sortKey(f.X) ? [s.wqrl, f.X] : [f.X, s.wqrl];
  const qPool = await a.call(s.v3Factory, 'getPool', [a.addr(s.wqrl), a.addr(f.X), 3000]);
  const qMint = a.encodeCall(s.npm, 'mint', [[a.addr(q0), a.addr(q1), 3000, -600, 600, E18 / 2n, E18 / 2n, 0n, 0n, me, DEADLINE]]);
  const refund = a.encodeCall(s.npm, 'refundQRL', []);
  const qBefore = await a.call(s.wqrl, 'balanceOf', [qPool]);
  await a.send(s.npm, 'multicall', [[qMint, refund]], { value: E18, tag: 'npm.multicall mint with QRL + refund' });
  R.set(c, 'npm.multicall(QRL mint) WQRL added to pool', (await a.call(s.wqrl, 'balanceOf', [qPool])) - qBefore, { cmp: false });
  R.check(c, 'npm.multicall(QRL mint) wrapped native QRL into the pool', (await a.call(s.wqrl, 'balanceOf', [qPool])) > qBefore);
  R.set(c, 'npm.native balance after refund', await a.nativeBalance(s.npm));

  // V3Migrator: half of the Y/Z V2 liquidity from v2() into the Y/Z V3 pool from v3().
  const v2Pair = a.at('PauliV2Pair', await a.call(s.v2Factory, 'getPair', [a.addr(f.Y), a.addr(f.Z)]));
  const lp = await a.call(v2Pair, 'balanceOf', [me]);
  await a.send(v2Pair, 'approve', [a.addr(s.migrator), lp]);
  const yBefore = await a.call(f.Y, 'balanceOf', [me]);
  const zBefore = await a.call(f.Z, 'balanceOf', [me]);
  const supplyBefore = await a.call(s.npm, 'totalSupply');
  await a.send(s.migrator, 'migrate', [[a.addr(v2Pair), lp, 50, a.addr(f.Y), a.addr(f.Z), 3000, -1200, 1200, 0n, 0n, me, DEADLINE, false]], { tag: 'v3migrator.migrate' });
  R.set(c, 'migrator: V2 LP left', await a.call(v2Pair, 'balanceOf', [me]));
  R.set(c, 'migrator: Y, Z refunded', [(await a.call(f.Y, 'balanceOf', [me])) - yBefore, (await a.call(f.Z, 'balanceOf', [me])) - zBefore]);
  R.set(c, 'migrator: NFTs minted', (await a.call(s.npm, 'totalSupply')) - supplyBefore);
  const mid = await a.call(s.npm, 'tokenOfOwnerByIndex', [me, (await a.call(s.npm, 'balanceOf', [me])) - 1n]);
  R.set(c, 'migrator: position liquidity', (await a.call(s.npm, 'positions', [mid]))[7]);
  R.set(c, 'migrator: allowances to the NPM after', [await a.call(f.Y, 'allowance', [a.addr(s.migrator), a.addr(s.npm)]), await a.call(f.Z, 'allowance', [a.addr(s.migrator), a.addr(s.npm)])]);
  R.set(c, 'migrator.revert: percentage 0', await a.revertReason(s.migrator, 'migrate', [[a.addr(v2Pair), 1n, 0, a.addr(f.Y), a.addr(f.Z), 3000, -1200, 1200, 0n, 0n, me, DEADLINE, false]]));
}

async function qrvmOnly(a, s, R) {
  const c = a.name;
  // Every deployed runtime must be the build output, with immutables and
  // library links as the only bytes the chain filled in.
  const masks = (art) => [...Object.values(art.immutableReferences || {}).flat(), ...Object.values(art.deployedLinkReferences || {}).flatMap((l) => Object.values(l).flat())];
  for (const [name, address] of Object.entries(a.deployment.contracts)) {
    if (name.startsWith('PoolCodeChunk')) continue;
    const art = artifact(name);
    let want = strip(art.deployedBytecode);
    let got = await a.code(address);
    if (name === 'Oracle') {
      // A library's runtime opens with PUSH64 of its own address, written at
      // deploy time: the call protection that rejects non DELEGATECALL entry.
      R.check(c, 'Oracle call protection slot holds its own address', got.slice(0, 2) === '9f' && got.slice(2, 130) === strip(address));
      got = want.slice(0, 130) + got.slice(130);
    }
    for (const { start, length } of masks(art)) {
      want = want.slice(0, start * 2) + '-'.repeat(length * 2) + want.slice((start + length) * 2);
      got = got.slice(0, start * 2) + '-'.repeat(length * 2) + got.slice((start + length) * 2);
    }
    R.check(c, `runtime code of ${name} matches build/qrvm`, got === want, `${got.length / 2} bytes`);
  }
  const poolInit = link(artifact('PauliV3Pool'), { Oracle: s.oracle });
  R.check(c, 'factory.poolCodeHash equals the linked pool init code', (await a.call(s.v3Factory, 'poolCodeHash')) === a.keccak(poolInit));
  const chunkCall = await a.rawCall(s.chunks[0], '0x12345678');
  R.check(c, 'calling a pool code chunk is a no-op', chunkCall.ok && (chunkCall.data === '0x' || !chunkCall.data));
  const oracleCall = await a.rawCall(s.oracle, '0x12345678');
  R.check(c, 'Oracle library rejects a direct call', !oracleCall.ok);
}

function compare(R) {
  const rows = [];
  const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  for (const row of R.rows.values()) {
    const both = 'qrvm' in row && 'evm' in row;
    const same = both && show(row.qrvm) === show(row.evm);
    rows.push({ key: row.key, compared: row.cmp && both, match: row.cmp && both ? same : null, qrvm: show(row.qrvm), evm: show(row.evm) });
  }
  return rows;
}

async function main() {
  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'devnet';
  const deployment = readDeployment(network);
  const chain = await new Chain(env).init();
  if (chain.chainId !== deployment.chainId) throw new Error(`deployment is for chain ${deployment.chainId}, node is ${chain.chainId}`);
  for (const [name, address] of Object.entries(deployment.contracts)) {
    if (strip(await chain.code(address)).length === 0) {
      throw new Error(`${name} has no code at ${address}; the chain was probably regenerated, redeploy first`);
    }
  }

  const R = new Recorder();
  const q = new QrvmAdapter(chain, deployment);
  const e = await new EvmAdapter(hre).init();
  const startBlock = Number(await chain.web3.qrl.getBlockNumber());

  for (const a of [e, q]) {
    console.log(`== ${a.name}`);
    const s = await systemFor(a);
    const f = await fixtures(a, s);
    if (a.name === 'qrvm') await qrvmOnly(a, s, R);
    await v2(a, s, f, R);
    await v3(a, s, f, R);
    await positions(a, s, f, R);
  }

  const rows = compare(R);
  const mismatches = rows.filter((r) => r.match === false);
  const failed = R.checks.filter((c) => !c.ok);
  const report = {
    network,
    chainId: chain.chainId,
    blocks: [startBlock, Number(await chain.web3.qrl.getBlockNumber())],
    ranAt: new Date().toISOString(),
    deployment,
    summary: {
      compared: rows.filter((r) => r.compared).length,
      matched: rows.filter((r) => r.match === true).length,
      mismatched: mismatches.length,
      checks: R.checks.length,
      checksFailed: failed.length,
    },
    rows,
    checks: R.checks,
    gas: Object.fromEntries(Object.keys(q.gas).map((k) => [k, { qrvm: q.gas[k].toString(), evm: (e.gas[k] ?? '').toString() }])),
  };
  const dir = path.join(ROOT, 'docs', 'onchain');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');

  console.log(`\ncompared ${report.summary.compared}, matched ${report.summary.matched}, mismatched ${mismatches.length}`);
  for (const m of mismatches) console.log(`  MISMATCH ${m.key}\n    qrvm ${m.qrvm}\n    evm  ${m.evm}`);
  console.log(`checks ${R.checks.length}, failed ${failed.length}`);
  console.log(`wrote ${path.relative(ROOT, file)}`);
  if (mismatches.length || failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
