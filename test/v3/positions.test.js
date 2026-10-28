const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MaxUint256 } = require('../helpers');

const FEE_MEDIUM = 3000;
const TICK_SPACING = 60;
const ENCODED_PRICE_1_1 = 79228162514264337593543950336n;
const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;

const getMinTick = (spacing) => Math.ceil(-887272 / spacing) * spacing;
const getMaxTick = (spacing) => Math.floor(887272 / spacing) * spacing;
const deadline = () => Math.floor(Date.now() / 1000) + 3600;

// Independent BigInt port of LiquidityAmounts, so the NPM's liquidity choice is
// checked against arithmetic that does not run through the contracts.
function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const l0 = (a, b) => (amount0 * ((a * b) / Q96)) / (b - a);
  const l1 = (a, b) => (amount1 * Q96) / (b - a);
  if (sqrtP <= sqrtA) return l0(sqrtA, sqrtB);
  if (sqrtP < sqrtB) {
    const x = l0(sqrtP, sqrtB);
    const y = l1(sqrtA, sqrtP);
    return x < y ? x : y;
  }
  return l1(sqrtA, sqrtB);
}

async function fixture() {
  const [wallet, other, third] = await ethers.getSigners();

  const factory = await deploy('PauliV3Factory', [], wallet);
  const wqrl = await deploy('WQRL', [], wallet);
  const descriptor = await deploy('PauliV3PositionDescriptor', [], wallet);
  const npm = await deploy(
    'NonfungiblePositionManager',
    [await factory.getAddress(), await wqrl.getAddress(), await descriptor.getAddress()],
    wallet
  );
  const router = await deploy('SwapRouter', [await factory.getAddress(), await wqrl.getAddress()], wallet);
  const caller = await deploy('PauliV3PoolCaller', [], wallet);
  const lens = await deploy('TickLens', [], wallet);
  const tickMath = await deploy('TickMathProbe', [], wallet);

  const tokens = [];
  for (let i = 0; i < 2; i++) tokens.push(await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet));
  const addrs = await Promise.all(tokens.map((t) => t.getAddress()));
  if (addrs[0].toLowerCase() > addrs[1].toLowerCase()) tokens.reverse();

  for (const token of tokens) {
    for (const spender of [npm, router, caller]) await token.approve(await spender.getAddress(), MaxUint256);
  }

  return { factory, wqrl, descriptor, npm, router, caller, lens, tickMath, tokens, wallet, other, third };
}

async function poolOf(ctx, a, b) {
  const address = await ctx.factory.getPool(a, b, FEE_MEDIUM);
  return ethers.getContractAt(artifactOf('PauliV3Pool').abi, address, ctx.wallet);
}

async function withPool(ctx) {
  const [t0, t1] = await Promise.all(ctx.tokens.map((t) => t.getAddress()));
  await ctx.npm.createAndInitializePoolIfNecessary(t0, t1, FEE_MEDIUM, ENCODED_PRICE_1_1);
  return { t0, t1, pool: await poolOf(ctx, t0, t1) };
}

async function mint(ctx, { t0, t1 }, lower, upper, amount, recipient) {
  const params = {
    token0: t0,
    token1: t1,
    fee: FEE_MEDIUM,
    tickLower: lower,
    tickUpper: upper,
    amount0Desired: amount,
    amount1Desired: amount,
    amount0Min: 0,
    amount1Min: 0,
    recipient: recipient ?? ctx.wallet.address,
    deadline: deadline(),
  };
  const result = await ctx.npm.mint.staticCall(params);
  await ctx.npm.mint(params);
  return result;
}

const positionKey = (owner, lower, upper) =>
  ethers.solidityPackedKeccak256(['address', 'int24', 'int24'], [owner, lower, upper]);

describe('NonfungiblePositionManager', () => {
  it('creates and initializes a pool once, and initializes an existing uninitialized pool', async () => {
    const ctx = await loadFixture(fixture);
    const [t0, t1] = await Promise.all(ctx.tokens.map((t) => t.getAddress()));

    await expect(ctx.npm.createAndInitializePoolIfNecessary(t1, t0, FEE_MEDIUM, ENCODED_PRICE_1_1)).to.be.reverted;

    await ctx.npm.createAndInitializePoolIfNecessary(t0, t1, FEE_MEDIUM, ENCODED_PRICE_1_1);
    const pool = await poolOf(ctx, t0, t1);
    expect((await pool.slot0()).sqrtPriceX96).to.equal(ENCODED_PRICE_1_1);

    // A second call with a different price must not touch the pool.
    await ctx.npm.createAndInitializePoolIfNecessary(t0, t1, FEE_MEDIUM, ENCODED_PRICE_1_1 * 2n);
    expect((await pool.slot0()).sqrtPriceX96).to.equal(ENCODED_PRICE_1_1);

    await ctx.factory.createPool(t0, t1, 500);
    await ctx.npm.createAndInitializePoolIfNecessary(t0, t1, 500, ENCODED_PRICE_1_1 * 2n);
    const other = await ethers.getContractAt(
      artifactOf('PauliV3Pool').abi,
      await ctx.factory.getPool(t0, t1, 500)
    );
    expect((await other.slot0()).sqrtPriceX96).to.equal(ENCODED_PRICE_1_1 * 2n);
  });

  it('mints a position NFT holding exactly the liquidity LiquidityAmounts prescribes', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const [lower, upper] = [-TICK_SPACING * 10, TICK_SPACING * 20];
    const amount = expandTo18Decimals(1000);

    const b0 = await ctx.tokens[0].balanceOf(ctx.wallet.address);
    const b1 = await ctx.tokens[1].balanceOf(ctx.wallet.address);
    const { tokenId, liquidity, amount0, amount1 } = await mint(ctx, keys, lower, upper, amount, ctx.other.address);

    const expected = liquidityForAmounts(
      ENCODED_PRICE_1_1,
      await ctx.tickMath.getSqrtRatioAtTick(lower),
      await ctx.tickMath.getSqrtRatioAtTick(upper),
      amount,
      amount
    );
    expect(liquidity).to.equal(expected);
    expect(tokenId).to.equal(1n);
    expect(b0 - (await ctx.tokens[0].balanceOf(ctx.wallet.address))).to.equal(amount0);
    expect(b1 - (await ctx.tokens[1].balanceOf(ctx.wallet.address))).to.equal(amount1);

    expect(await ctx.npm.ownerOf(1)).to.equal(ctx.other.address);
    expect(await ctx.npm.balanceOf(ctx.other.address)).to.equal(1n);
    expect(await ctx.npm.totalSupply()).to.equal(1n);
    expect(await ctx.npm.tokenOfOwnerByIndex(ctx.other.address, 0)).to.equal(1n);
    expect(await ctx.npm.tokenByIndex(0)).to.equal(1n);

    const p = await ctx.npm.positions(1);
    expect(p.nonce).to.equal(0n);
    expect(p.operator).to.equal(ethers.ZeroAddress);
    expect([p.token0, p.token1, p.fee]).to.deep.equal([keys.t0, keys.t1, BigInt(FEE_MEDIUM)]);
    expect([p.tickLower, p.tickUpper]).to.deep.equal([BigInt(lower), BigInt(upper)]);
    expect(p.liquidity).to.equal(liquidity);
    expect([p.tokensOwed0, p.tokensOwed1]).to.deep.equal([0n, 0n]);

    const core = await keys.pool.positions(positionKey(await ctx.npm.getAddress(), lower, upper));
    expect(core.liquidity).to.equal(liquidity);
  });

  it('accrues and collects the same fees core pays a directly minted twin position', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const [lower, upper] = [-TICK_SPACING * 10, TICK_SPACING * 10];
    const { liquidity } = await mint(ctx, keys, lower, upper, expandTo18Decimals(1000));
    await ctx.caller.mint(await keys.pool.getAddress(), ctx.wallet.address, lower, upper, liquidity);

    for (const [tokenIn, tokenOut] of [
      [keys.t0, keys.t1],
      [keys.t1, keys.t0],
      [keys.t0, keys.t1],
    ]) {
      await ctx.router.exactInputSingle({
        tokenIn,
        tokenOut,
        fee: FEE_MEDIUM,
        recipient: ctx.wallet.address,
        deadline: deadline(),
        amountIn: expandTo18Decimals(10),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });
    }

    await keys.pool.burn(lower, upper, 0);
    const twin = await keys.pool.collect.staticCall(ctx.third.address, lower, upper, MAX_UINT128, MAX_UINT128);
    expect(twin.amount0).to.be.gt(0n);
    expect(twin.amount1).to.be.gt(0n);

    const params = { tokenId: 1, recipient: ctx.third.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 };
    const got = await ctx.npm.collect.staticCall(params);
    expect(got.amount0).to.equal(twin.amount0);
    expect(got.amount1).to.equal(twin.amount1);

    await ctx.npm.collect(params);
    expect(await ctx.tokens[0].balanceOf(ctx.third.address)).to.equal(twin.amount0);
    expect(await ctx.tokens[1].balanceOf(ctx.third.address)).to.equal(twin.amount1);
    const p = await ctx.npm.positions(1);
    expect([p.tokensOwed0, p.tokensOwed1]).to.deep.equal([0n, 0n]);
  });

  it('increases liquidity, folding accrued fees into tokensOwed', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const [lower, upper] = [getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING)];
    const first = await mint(ctx, keys, lower, upper, expandTo18Decimals(100));

    await ctx.router.exactInputSingle({
      tokenIn: keys.t0,
      tokenOut: keys.t1,
      fee: FEE_MEDIUM,
      recipient: ctx.wallet.address,
      deadline: deadline(),
      amountIn: expandTo18Decimals(1),
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });

    const params = {
      tokenId: 1,
      amount0Desired: expandTo18Decimals(50),
      amount1Desired: expandTo18Decimals(50),
      amount0Min: 0,
      amount1Min: 0,
      deadline: deadline(),
    };
    const added = await ctx.npm.increaseLiquidity.staticCall(params);
    await expect(ctx.npm.increaseLiquidity(params))
      .to.emit(ctx.npm, 'IncreaseLiquidity')
      .withArgs(1, added.liquidity, added.amount0, added.amount1);

    const p = await ctx.npm.positions(1);
    expect(p.liquidity).to.equal(first.liquidity + added.liquidity);
    // 0.3% of 1e18 paid in token0, all of it to this one position, rounded
    // down by the X128 fixed point.
    expect(p.tokensOwed0).to.be.within(expandTo18Decimals(1) * 3n / 1000n - 2n, expandTo18Decimals(1) * 3n / 1000n);
    expect(p.tokensOwed1).to.equal(0n);
  });

  it('decreases liquidity into tokensOwed, then collects and burns', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const [lower, upper] = [-TICK_SPACING, TICK_SPACING];
    const { liquidity } = await mint(ctx, keys, lower, upper, expandTo18Decimals(10));

    await expect(ctx.npm.burn(1)).to.be.revertedWith('Not cleared');
    await expect(
      ctx.npm.decreaseLiquidity({ tokenId: 1, liquidity: liquidity + 1n, amount0Min: 0, amount1Min: 0, deadline: deadline() })
    ).to.be.reverted;
    await expect(
      ctx.npm.decreaseLiquidity({ tokenId: 1, liquidity, amount0Min: MaxUint256, amount1Min: 0, deadline: deadline() })
    ).to.be.revertedWith('Price slippage check');

    const dec = { tokenId: 1, liquidity, amount0Min: 0, amount1Min: 0, deadline: deadline() };
    const out = await ctx.npm.decreaseLiquidity.staticCall(dec);
    await ctx.npm.decreaseLiquidity(dec);
    let p = await ctx.npm.positions(1);
    expect(p.liquidity).to.equal(0n);
    expect([p.tokensOwed0, p.tokensOwed1]).to.deep.equal([out.amount0, out.amount1]);

    await expect(ctx.npm.burn(1)).to.be.revertedWith('Not cleared');

    // Collecting only part leaves the rest owed.
    await ctx.npm.collect({ tokenId: 1, recipient: ctx.third.address, amount0Max: 1, amount1Max: 0 });
    p = await ctx.npm.positions(1);
    expect(p.tokensOwed0).to.equal(out.amount0 - 1n);

    await ctx.npm.collect({ tokenId: 1, recipient: ctx.third.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 });
    expect(await ctx.tokens[0].balanceOf(ctx.third.address)).to.equal(out.amount0);
    expect(await ctx.tokens[1].balanceOf(ctx.third.address)).to.equal(out.amount1);

    await ctx.npm.burn(1);
    await expect(ctx.npm.positions(1)).to.be.revertedWith('Invalid token ID');
    expect(await ctx.npm.totalSupply()).to.equal(0n);
    expect(await ctx.npm.balanceOf(ctx.wallet.address)).to.equal(0n);
  });

  it('gates decrease, collect and burn on owner, approved and operator', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const { liquidity } = await mint(ctx, keys, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(10));
    const half = { tokenId: 1, liquidity: liquidity / 4n, amount0Min: 0, amount1Min: 0, deadline: deadline() };
    const collect = { tokenId: 1, recipient: ctx.other.address, amount0Max: 1, amount1Max: 1 };

    const asOther = ctx.npm.connect(ctx.other);
    await expect(asOther.decreaseLiquidity(half)).to.be.revertedWith('Not approved');
    await expect(asOther.collect(collect)).to.be.revertedWith('Not approved');
    await expect(asOther.burn(1)).to.be.revertedWith('Not approved');

    await ctx.npm.approve(ctx.other.address, 1);
    expect((await ctx.npm.positions(1)).operator).to.equal(ctx.other.address);
    await asOther.decreaseLiquidity(half);

    await ctx.npm.approve(ethers.ZeroAddress, 1);
    await expect(asOther.decreaseLiquidity(half)).to.be.revertedWith('Not approved');

    await ctx.npm.setApprovalForAll(ctx.other.address, true);
    await asOther.decreaseLiquidity(half);
    await asOther.collect(collect);
    await ctx.npm.setApprovalForAll(ctx.other.address, false);

    // A transfer clears the single token approval.
    await ctx.npm.approve(ctx.other.address, 1);
    await ctx.npm['safeTransferFrom(address,address,uint256)'](ctx.wallet.address, ctx.third.address, 1);
    expect((await ctx.npm.positions(1)).operator).to.equal(ethers.ZeroAddress);
    await expect(asOther.decreaseLiquidity(half)).to.be.revertedWith('Not approved');
    await expect(ctx.npm.decreaseLiquidity(half)).to.be.revertedWith('Not approved');
    await ctx.npm.connect(ctx.third).decreaseLiquidity(half);
  });

  it('keeps per owner enumeration consistent across transfers and burns', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    for (let i = 1; i <= 3; i++) await mint(ctx, keys, -TICK_SPACING * i, TICK_SPACING * i, expandTo18Decimals(1));

    await ctx.npm.transferFrom(ctx.wallet.address, ctx.other.address, 1);
    const owned = async (who) => {
      const n = await ctx.npm.balanceOf(who);
      const ids = [];
      for (let i = 0n; i < n; i++) ids.push(await ctx.npm.tokenOfOwnerByIndex(who, i));
      return ids.sort();
    };
    expect(await owned(ctx.wallet.address)).to.deep.equal([2n, 3n]);
    expect(await owned(ctx.other.address)).to.deep.equal([1n]);
    await expect(ctx.npm.tokenOfOwnerByIndex(ctx.other.address, 1)).to.be.reverted;

    const p = await ctx.npm.positions(2);
    await ctx.npm.decreaseLiquidity({ tokenId: 2, liquidity: p.liquidity, amount0Min: 0, amount1Min: 0, deadline: deadline() });
    await ctx.npm.collect({ tokenId: 2, recipient: ctx.wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 });
    await ctx.npm.burn(2);
    expect(await owned(ctx.wallet.address)).to.deep.equal([3n]);
    expect(await ctx.npm.totalSupply()).to.equal(2n);
  });

  it('creates a pool and mints with native QRL in one multicall, refunding the excess', async () => {
    const ctx = await loadFixture(fixture);
    const token = await ctx.tokens[0].getAddress();
    const wqrl = await ctx.wqrl.getAddress();
    const [t0, t1] = token.toLowerCase() < wqrl.toLowerCase() ? [token, wqrl] : [wqrl, token];
    const amount = expandTo18Decimals(1);

    const calls = [
      ctx.npm.interface.encodeFunctionData('createAndInitializePoolIfNecessary', [t0, t1, FEE_MEDIUM, ENCODED_PRICE_1_1]),
      ctx.npm.interface.encodeFunctionData('mint', [
        {
          token0: t0,
          token1: t1,
          fee: FEE_MEDIUM,
          tickLower: getMinTick(TICK_SPACING),
          tickUpper: getMaxTick(TICK_SPACING),
          amount0Desired: amount,
          amount1Desired: amount,
          amount0Min: 0,
          amount1Min: 0,
          recipient: ctx.wallet.address,
          deadline: deadline(),
        },
      ]),
      ctx.npm.interface.encodeFunctionData('refundQRL'),
    ];
    const before = await ethers.provider.getBalance(ctx.wallet.address);
    const tx = await ctx.npm.multicall(calls, { value: amount * 2n });
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;

    const pool = await poolOf(ctx, t0, t1);
    expect(await ctx.wqrl.balanceOf(await pool.getAddress())).to.equal(amount);
    expect(before - (await ethers.provider.getBalance(ctx.wallet.address)) - gas).to.equal(amount);
    expect(await ethers.provider.getBalance(await ctx.npm.getAddress())).to.equal(0n);
    expect(await ctx.npm.ownerOf(1)).to.equal(ctx.wallet.address);
  });

  it('forwards a string revert reason out of multicall and reverts on a custom error', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    await mint(ctx, keys, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(1));
    const asOther = ctx.npm.connect(ctx.other);

    const dec = ctx.npm.interface.encodeFunctionData('decreaseLiquidity', [
      { tokenId: 1, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: deadline() },
    ]);
    await expect(asOther.multicall([dec])).to.be.revertedWith('Not approved');

    // SQRCTN1 reverts with custom errors; Multicall only re-raises
    // Error(string), as upstream, so this must still revert, reason or not.
    const steal = ctx.npm.interface.encodeFunctionData('transferFrom', [ctx.wallet.address, ctx.other.address, 1]);
    await expect(asOther.multicall([steal])).to.be.reverted;
    expect(await ctx.npm.ownerOf(1)).to.equal(ctx.wallet.address);
  });

  it('rejects a mint callback from a contract that is not the pool', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(tuple(address,address,uint24),address)'],
      [[[keys.t0, keys.t1, FEE_MEDIUM], ctx.wallet.address]]
    );
    await expect(ctx.npm.pauliV3MintCallback(1, 1, data)).to.be.reverted;
  });

  it('describes a position through the descriptor', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    await mint(ctx, keys, -TICK_SPACING * 2, TICK_SPACING * 3, expandTo18Decimals(1));

    const uri = await ctx.npm.tokenURI(1);
    expect(uri.startsWith('data:application/json;base64,')).to.equal(true);
    const json = JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
    const sym = await ctx.tokens[0].symbol();
    expect(json.name).to.equal(`Pauli - 0.3% - ${sym}/${sym} - -120<>180`);
    expect(json.description).to.contain(`Pool Address: Q${(await keys.pool.getAddress()).slice(2).toLowerCase()}`);
    expect(json.description).to.contain('Token ID: 1');
    await expect(ctx.npm.tokenURI(2)).to.be.reverted;
  });

  it('formats every enabled fee tier', async () => {
    const ctx = await loadFixture(fixture);
    const [t0, t1] = await Promise.all(ctx.tokens.map((t) => t.getAddress()));
    for (const [fee, spacing, text] of [
      [500, 10, '0.05%'],
      [10000, 200, '1%'],
    ]) {
      await ctx.npm.createAndInitializePoolIfNecessary(t0, t1, fee, ENCODED_PRICE_1_1);
      const params = {
        token0: t0,
        token1: t1,
        fee,
        tickLower: -spacing,
        tickUpper: spacing,
        amount0Desired: expandTo18Decimals(1),
        amount1Desired: expandTo18Decimals(1),
        amount0Min: 0,
        amount1Min: 0,
        recipient: ctx.wallet.address,
        deadline: deadline(),
      };
      const { tokenId } = await ctx.npm.mint.staticCall(params);
      await ctx.npm.mint(params);
      const uri = await ctx.npm.tokenURI(tokenId);
      const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
      expect(json.name).to.contain(` - ${text} - `);
    }
  });
});

describe('TickLens', () => {
  it('returns every populated tick of a bitmap word with the pool tick data', async () => {
    const ctx = await loadFixture(fixture);
    const keys = await withPool(ctx);
    await mint(ctx, keys, -TICK_SPACING * 2, TICK_SPACING * 3, expandTo18Decimals(1));
    await mint(ctx, keys, -TICK_SPACING * 2, TICK_SPACING, expandTo18Decimals(1));

    const pool = await keys.pool.getAddress();
    const negative = await ctx.lens.getPopulatedTicksInWord(pool, -1);
    const positive = await ctx.lens.getPopulatedTicksInWord(pool, 0);
    const all = [...negative, ...positive].map((t) => Number(t.tick)).sort((a, b) => a - b);
    expect(all).to.deep.equal([-120, 60, 180]);

    for (const t of [...negative, ...positive]) {
      const core = await keys.pool.ticks(t.tick);
      expect(t.liquidityGross).to.equal(core.liquidityGross);
      expect(t.liquidityNet).to.equal(core.liquidityNet);
    }
    expect(await ctx.lens.getPopulatedTicksInWord(pool, 5)).to.deep.equal([]);
  });
});

describe('V3Migrator', () => {
  async function migratorFixture() {
    const ctx = await fixture();
    const v2 = await deploy('PauliV2Factory', [ctx.wallet.address], ctx.wallet);
    const v2Router = await deploy(
      'PauliV2Router02',
      [await v2.getAddress(), await ctx.wqrl.getAddress()],
      ctx.wallet
    );
    const migrator = await deploy(
      'V3Migrator',
      [await ctx.factory.getAddress(), await ctx.wqrl.getAddress(), await ctx.npm.getAddress()],
      ctx.wallet
    );
    for (const token of ctx.tokens) await token.approve(await v2Router.getAddress(), MaxUint256);
    const [t0, t1] = await Promise.all(ctx.tokens.map((t) => t.getAddress()));
    await v2Router.addLiquidity(t0, t1, expandTo18Decimals(100), expandTo18Decimals(100), 0, 0, ctx.wallet.address, deadline());
    const pair = await ethers.getContractAt(artifactOf('PauliV2Pair').abi, await v2.getPair(t0, t1), ctx.wallet);
    return { ...ctx, v2, migrator, pair, t0, t1 };
  }

  it('moves V2 liquidity into a V3 position and refunds the unmigrated share', async () => {
    const ctx = await loadFixture(migratorFixture);
    const lp = await ctx.pair.balanceOf(ctx.wallet.address);
    const [r0, r1] = await ctx.pair.getReserves();
    const supply = await ctx.pair.totalSupply();
    const out0 = (lp * r0) / supply;
    const out1 = (lp * r1) / supply;

    await ctx.npm.createAndInitializePoolIfNecessary(ctx.t0, ctx.t1, FEE_MEDIUM, ENCODED_PRICE_1_1);
    await ctx.pair.approve(await ctx.migrator.getAddress(), lp);

    const b0 = await ctx.tokens[0].balanceOf(ctx.wallet.address);
    const b1 = await ctx.tokens[1].balanceOf(ctx.wallet.address);
    await ctx.migrator.migrate({
      pair: await ctx.pair.getAddress(),
      liquidityToMigrate: lp,
      percentageToMigrate: 50,
      token0: ctx.t0,
      token1: ctx.t1,
      fee: FEE_MEDIUM,
      tickLower: getMinTick(TICK_SPACING),
      tickUpper: getMaxTick(TICK_SPACING),
      amount0Min: 0,
      amount1Min: 0,
      recipient: ctx.other.address,
      deadline: deadline(),
      refundAsQRL: false,
    });

    expect(await ctx.pair.balanceOf(ctx.wallet.address)).to.equal(0n);
    expect(await ctx.npm.ownerOf(1)).to.equal(ctx.other.address);
    const p = await ctx.npm.positions(1);
    const pool = await poolOf(ctx, ctx.t0, ctx.t1);
    const in0 = await ctx.tokens[0].balanceOf(await pool.getAddress());
    const in1 = await ctx.tokens[1].balanceOf(await pool.getAddress());
    expect(p.liquidity).to.be.gt(0n);
    // Everything burned from V2 ends up either in the pool or back with the caller.
    expect((await ctx.tokens[0].balanceOf(ctx.wallet.address)) - b0 + in0).to.equal(out0);
    expect((await ctx.tokens[1].balanceOf(ctx.wallet.address)) - b1 + in1).to.equal(out1);
    expect(in0).to.be.within((out0 / 2n) - 1n, out0 / 2n);
    expect(await ctx.tokens[0].allowance(await ctx.migrator.getAddress(), await ctx.npm.getAddress())).to.equal(0n);
  });

  it('rejects an out of range percentage', async () => {
    const ctx = await loadFixture(migratorFixture);
    const base = {
      pair: await ctx.pair.getAddress(),
      liquidityToMigrate: 1,
      token0: ctx.t0,
      token1: ctx.t1,
      fee: FEE_MEDIUM,
      tickLower: -TICK_SPACING,
      tickUpper: TICK_SPACING,
      amount0Min: 0,
      amount1Min: 0,
      recipient: ctx.wallet.address,
      deadline: deadline(),
      refundAsQRL: false,
    };
    await expect(ctx.migrator.migrate({ ...base, percentageToMigrate: 0 })).to.be.revertedWith('Percentage too small');
    await expect(ctx.migrator.migrate({ ...base, percentageToMigrate: 101 })).to.be.revertedWith('Percentage too large');
  });
});
