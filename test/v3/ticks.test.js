const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MaxUint256 } = require('../helpers');

const FEE_MEDIUM = 3000;
const TICK_SPACING = 60;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const ENCODED_PRICE_1_1 = 79228162514264337593543950336n;

const getMinTick = (spacing) => Math.ceil(-887272 / spacing) * spacing;
const getMaxTick = (spacing) => Math.floor(887272 / spacing) * spacing;

async function fixture() {
  const [wallet, other] = await ethers.getSigners();

  const factory = await deploy('AcornV3Factory', [], wallet);
  const caller = await deploy('AcornV3PoolCaller', [], wallet);

  let tokenA = await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet);
  let tokenB = await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet);
  if ((await tokenA.getAddress()).toLowerCase() > (await tokenB.getAddress()).toLowerCase()) {
    [tokenA, tokenB] = [tokenB, tokenA];
  }

  await factory.createPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_MEDIUM);
  const pool = await ethers.getContractAt(
    artifactOf('AcornV3Pool').abi,
    await factory.getPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_MEDIUM),
    wallet
  );
  await pool.initialize(ENCODED_PRICE_1_1);

  for (const token of [tokenA, tokenB]) {
    await token.approve(await caller.getAddress(), MaxUint256);
  }

  return { factory, pool, caller, token0: tokenA, token1: tokenB, wallet, other };
}

// A swap that leaves the current tick range has to walk the bitmap, cross an
// initialized tick and apply liquidityNet with the sign flipped for zeroForOne.
// That path exercises every int24/uint24 conversion the port had to rewrite, so
// it gets its own suite.
describe('AcornV3Pool tick crossing', () => {
  async function narrowPositions() {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    const poolAddress = await pool.getAddress();

    // Wide base position plus two narrow ones that the price must cross.
    await caller.mint(poolAddress, wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(10));
    await caller.mint(poolAddress, wallet.address, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(100));
    await caller.mint(poolAddress, wallet.address, -TICK_SPACING * 4, -TICK_SPACING * 2, expandTo18Decimals(100));

    return ctx;
  }

  it('registers the narrow positions in the tick bitmap', async () => {
    const { pool } = await narrowPositions();
    for (const tick of [-TICK_SPACING * 4, -TICK_SPACING * 2, -TICK_SPACING, TICK_SPACING]) {
      const info = await pool.ticks(tick);
      expect(info.initialized, `tick ${tick}`).to.equal(true);
      expect(info.liquidityGross).to.be.greaterThan(0n);
    }
  });

  it('drops liquidity when the price crosses out of a narrow range', async () => {
    const { pool, caller, wallet } = await narrowPositions();
    const liquidityBefore = await pool.liquidity();

    // Large enough to push the price below -TICK_SPACING.
    await caller.swap(await pool.getAddress(), wallet.address, true, expandTo18Decimals(5), MIN_SQRT_RATIO + 1n);

    const [, tickAfter] = await pool.slot0();
    expect(tickAfter).to.be.lessThan(-TICK_SPACING);
    expect(await pool.liquidity()).to.be.lessThan(liquidityBefore);
  });

  it('picks liquidity back up when the price crosses back in', async () => {
    const { pool, caller, wallet } = await narrowPositions();
    const poolAddress = await pool.getAddress();
    const liquidityStart = await pool.liquidity();

    await caller.swap(poolAddress, wallet.address, true, expandTo18Decimals(5), MIN_SQRT_RATIO + 1n);
    const [, tickOut] = await pool.slot0();
    expect(tickOut).to.be.lessThan(-TICK_SPACING);

    // Swap back the other way, far enough to re-enter the narrow range.
    await caller.swap(poolAddress, wallet.address, false, expandTo18Decimals(5), MAX_SQRT_RATIO - 1n);
    const [, tickBack] = await pool.slot0();
    expect(tickBack).to.be.greaterThan(tickOut);
    expect(await pool.liquidity()).to.be.greaterThan(0n);
    expect(liquidityStart).to.be.greaterThan(0n);
  });

  it('records feeGrowthOutside on crossed ticks', async () => {
    const { pool, caller, wallet } = await narrowPositions();

    await caller.swap(await pool.getAddress(), wallet.address, true, expandTo18Decimals(5), MIN_SQRT_RATIO + 1n);

    const crossed = await pool.ticks(-TICK_SPACING);
    expect(crossed.feeGrowthOutside0X128).to.be.greaterThan(0n);
  });

  it('clears tick state once the last position on it is burned', async () => {
    const { pool, wallet } = await narrowPositions();

    await pool.burn(-TICK_SPACING, TICK_SPACING, expandTo18Decimals(100));

    const lower = await pool.ticks(-TICK_SPACING);
    expect(lower.initialized).to.equal(false);
    expect(lower.liquidityGross).to.equal(0n);
  });

  it('mints a position entirely above the current price using only token1', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, token0, token1, wallet } = ctx;

    const before0 = await token0.balanceOf(wallet.address);
    const before1 = await token1.balanceOf(wallet.address);

    // Range strictly below the current tick needs token1 only.
    await caller.mint(await pool.getAddress(), wallet.address, -TICK_SPACING * 4, -TICK_SPACING * 2, expandTo18Decimals(1));

    expect(before0 - (await token0.balanceOf(wallet.address))).to.equal(0n);
    expect(before1 - (await token1.balanceOf(wallet.address))).to.be.greaterThan(0n);
  });

  it('mints a position entirely below the current price using only token0', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, token0, token1, wallet } = ctx;

    const before0 = await token0.balanceOf(wallet.address);
    const before1 = await token1.balanceOf(wallet.address);

    await caller.mint(await pool.getAddress(), wallet.address, TICK_SPACING * 2, TICK_SPACING * 4, expandTo18Decimals(1));

    expect(before0 - (await token0.balanceOf(wallet.address))).to.be.greaterThan(0n);
    expect(before1 - (await token1.balanceOf(wallet.address))).to.equal(0n);
  });

  it('rejects a tick that is not a multiple of the spacing', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await expect(
      caller.mint(await pool.getAddress(), wallet.address, -TICK_SPACING + 1, TICK_SPACING, expandTo18Decimals(1))
    ).to.be.reverted;
  });

  it('keeps two positions on the same range accounted separately', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet, other } = ctx;
    const poolAddress = await pool.getAddress();

    await caller.mint(poolAddress, wallet.address, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(1));
    await caller.mint(poolAddress, other.address, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(3));

    const key = (owner) =>
      ethers.keccak256(ethers.solidityPacked(['address', 'int24', 'int24'], [owner, -TICK_SPACING, TICK_SPACING]));

    expect((await pool.positions(key(wallet.address))).liquidity).to.equal(expandTo18Decimals(1));
    expect((await pool.positions(key(other.address))).liquidity).to.equal(expandTo18Decimals(3));

    const tickInfo = await pool.ticks(-TICK_SPACING);
    expect(tickInfo.liquidityGross).to.equal(expandTo18Decimals(4));
  });
});

describe('AcornV3Pool oracle', () => {
  it('accumulates tickCumulative over elapsed time', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(10));

    const [first] = await pool.observe([0]);
    await time.increase(100);
    const [second] = await pool.observe([0]);

    // Tick is 0 here, so tickCumulative stays put while secondsPerLiquidity grows.
    expect(second[0]).to.equal(first[0]);

    await caller.swap(await pool.getAddress(), wallet.address, true, expandTo18Decimals(1), MIN_SQRT_RATIO + 1n);
    await time.increase(100);
    const [third] = await pool.observe([0]);
    expect(third[0]).to.be.lessThan(second[0]);
  });

  it('returns older observations after growing cardinality', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(10));

    await pool.increaseObservationCardinalityNext(4);

    for (let i = 0; i < 3; i++) {
      await time.increase(60);
      await caller.swap(
        await pool.getAddress(),
        wallet.address,
        i % 2 === 0,
        expandTo18Decimals(1) / 100n,
        i % 2 === 0 ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n
      );
    }

    const [cumulatives, perLiquidity] = await pool.observe([0, 60]);
    expect(cumulatives.length).to.equal(2);
    expect(perLiquidity[0]).to.be.greaterThan(perLiquidity[1]);
  });

  it('reverts when asked for an observation older than the array holds', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(10));

    await time.increase(100);
    await expect(pool.observe([1000])).to.be.revertedWith('OLD');
  });

  it('reports cumulatives inside a range', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await caller.mint(await pool.getAddress(), wallet.address, -TICK_SPACING, TICK_SPACING, expandTo18Decimals(10));

    await time.increase(60);
    const snapshot = await pool.snapshotCumulativesInside(-TICK_SPACING, TICK_SPACING);
    expect(snapshot.secondsInside).to.be.greaterThan(0n);
  });

  it('refuses a snapshot over an uninitialized range', async () => {
    const ctx = await loadFixture(fixture);
    const { pool } = ctx;
    await expect(pool.snapshotCumulativesInside(-TICK_SPACING, TICK_SPACING)).to.be.reverted;
  });
});

describe('NoDelegateCall', () => {
  it('blocks swap and observe when reached through delegatecall', async () => {
    const ctx = await loadFixture(fixture);
    const { pool, caller, wallet } = ctx;
    await caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(10));

    const probe = await deploy('NoDelegateCallProbe', [], wallet);

    expect(
      await probe.delegateSwap.staticCall(
        await pool.getAddress(),
        wallet.address,
        true,
        expandTo18Decimals(1) / 1000n,
        MIN_SQRT_RATIO + 1n
      )
    ).to.equal(false);

    expect(await probe.delegateObserve.staticCall(await pool.getAddress())).to.equal(false);
  });
});
