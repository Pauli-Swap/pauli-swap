const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
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

  const factory = await deploy('PauliV3Factory', [], wallet);
  const caller = await deploy('PauliV3PoolCaller', [], wallet);

  let tokenA = await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet);
  let tokenB = await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet);
  if ((await tokenA.getAddress()).toLowerCase() > (await tokenB.getAddress()).toLowerCase()) {
    [tokenA, tokenB] = [tokenB, tokenA];
  }

  await factory.createPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_MEDIUM);
  const pool = await ethers.getContractAt(
    artifactOf('PauliV3Pool').abi,
    await factory.getPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_MEDIUM),
    wallet
  );

  for (const token of [tokenA, tokenB]) {
    await token.approve(await caller.getAddress(), MaxUint256);
  }

  return { factory, pool, caller, token0: tokenA, token1: tokenB, wallet, other };
}

async function initialized() {
  const ctx = await loadFixture(fixture);
  await ctx.pool.initialize(ENCODED_PRICE_1_1);
  await ctx.caller.mint(
    await ctx.pool.getAddress(),
    ctx.wallet.address,
    getMinTick(TICK_SPACING),
    getMaxTick(TICK_SPACING),
    expandTo18Decimals(2)
  );
  return ctx;
}

describe('PauliV3Factory', () => {
  it('enables the three canonical fee tiers', async () => {
    const { factory } = await loadFixture(fixture);
    expect(await factory.feeAmountTickSpacing(500)).to.equal(10n);
    expect(await factory.feeAmountTickSpacing(3000)).to.equal(60n);
    expect(await factory.feeAmountTickSpacing(10000)).to.equal(200n);
  });

  it('deploys the pool at its CREATE2 address', async () => {
    const { factory, pool, token0, token1 } = await loadFixture(fixture);
    const expected = ethers.getCreate2Address(
      await factory.getAddress(),
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'uint24'],
          [await token0.getAddress(), await token1.getAddress(), FEE_MEDIUM]
        )
      ),
      ethers.keccak256(artifactOf('PauliV3Pool').bytecode)
    );
    expect(await pool.getAddress()).to.equal(expected);
  });

  it('sets the pool immutables from the transient deployer parameters', async () => {
    const { factory, pool, token0, token1 } = await loadFixture(fixture);
    expect(await pool.factory()).to.equal(await factory.getAddress());
    expect(await pool.token0()).to.equal(await token0.getAddress());
    expect(await pool.token1()).to.equal(await token1.getAddress());
    expect(await pool.fee()).to.equal(BigInt(FEE_MEDIUM));
    expect(await pool.tickSpacing()).to.equal(BigInt(TICK_SPACING));
    expect(await pool.maxLiquidityPerTick()).to.be.greaterThan(0n);
  });

  it('clears the deployer parameters after deployment', async () => {
    const { factory } = await loadFixture(fixture);
    const params = await factory.parameters();
    expect(params.factory).to.equal(ethers.ZeroAddress);
  });

  it('rejects a duplicate pool and an unknown fee tier', async () => {
    const { factory, token0, token1 } = await loadFixture(fixture);
    await expect(factory.createPool(await token0.getAddress(), await token1.getAddress(), FEE_MEDIUM)).to.be.reverted;
    await expect(factory.createPool(await token0.getAddress(), await token1.getAddress(), 1234)).to.be.reverted;
  });

  it('lets the owner enable a new fee tier and hand over ownership', async () => {
    const { factory, wallet, other } = await loadFixture(fixture);
    await expect(factory.enableFeeAmount(100, 1)).to.emit(factory, 'FeeAmountEnabled').withArgs(100, 1);
    expect(await factory.feeAmountTickSpacing(100)).to.equal(1n);

    await expect(factory.connect(other).enableFeeAmount(250, 5)).to.be.reverted;
    await expect(factory.setOwner(other.address)).to.emit(factory, 'OwnerChanged').withArgs(wallet.address, other.address);
    await expect(factory.setOwner(wallet.address)).to.be.reverted;
  });

  it('caps tick spacing below 16384', async () => {
    const { factory } = await loadFixture(fixture);
    await expect(factory.enableFeeAmount(100, 16384)).to.be.reverted;
    await expect(factory.enableFeeAmount(100, 0)).to.be.reverted;
    await expect(factory.enableFeeAmount(1000000, 10)).to.be.reverted;
  });
});

describe('PauliV3Pool', () => {
  it('is locked until initialized', async () => {
    const { pool, caller, wallet } = await loadFixture(fixture);
    const [sqrtPriceX96, , , , , , unlocked] = await pool.slot0();
    expect(sqrtPriceX96).to.equal(0n);
    expect(unlocked).to.equal(false);

    await expect(
      caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), 1n)
    ).to.be.revertedWith('LOK');
  });

  it('initializes price and tick and refuses a second initialize', async () => {
    const { pool } = await loadFixture(fixture);
    await expect(pool.initialize(ENCODED_PRICE_1_1)).to.emit(pool, 'Initialize').withArgs(ENCODED_PRICE_1_1, 0n);

    const [sqrtPriceX96, tick, , observationCardinality, , , unlocked] = await pool.slot0();
    expect(sqrtPriceX96).to.equal(ENCODED_PRICE_1_1);
    expect(tick).to.equal(0n);
    expect(observationCardinality).to.equal(1n);
    expect(unlocked).to.equal(true);

    await expect(pool.initialize(ENCODED_PRICE_1_1)).to.be.revertedWith('AI');
  });

  it('mints liquidity and pulls both tokens through the callback', async () => {
    const { pool, caller, token0, token1, wallet } = await loadFixture(fixture);
    await pool.initialize(ENCODED_PRICE_1_1);

    const before0 = await token0.balanceOf(wallet.address);
    const before1 = await token1.balanceOf(wallet.address);

    await caller.mint(
      await pool.getAddress(),
      wallet.address,
      getMinTick(TICK_SPACING),
      getMaxTick(TICK_SPACING),
      expandTo18Decimals(2)
    );

    expect(await pool.liquidity()).to.equal(expandTo18Decimals(2));
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(before0 - (await token0.balanceOf(wallet.address)));
    expect(await token1.balanceOf(await pool.getAddress())).to.equal(before1 - (await token1.balanceOf(wallet.address)));
  });

  it('rejects invalid tick ranges', async () => {
    const { pool, caller, wallet } = await loadFixture(fixture);
    await pool.initialize(ENCODED_PRICE_1_1);
    const poolAddress = await pool.getAddress();

    await expect(caller.mint(poolAddress, wallet.address, 60, 0, 1n)).to.be.revertedWith('TLU');
    await expect(caller.mint(poolAddress, wallet.address, -887280, 0, 1n)).to.be.revertedWith('TLM');
    await expect(caller.mint(poolAddress, wallet.address, 0, 887280, 1n)).to.be.revertedWith('TUM');
  });

  it('swaps token0 for token1 and moves the price down', async () => {
    const { pool, caller, token1, wallet } = await initialized();

    const [priceBefore] = await pool.slot0();
    const before = await token1.balanceOf(wallet.address);

    await caller.swap(
      await pool.getAddress(),
      wallet.address,
      true,
      expandTo18Decimals(1) / 1000n,
      MIN_SQRT_RATIO + 1n
    );

    const [priceAfter, tickAfter] = await pool.slot0();
    expect(priceAfter).to.be.lessThan(priceBefore);
    expect(tickAfter).to.be.lessThan(0n);
    expect(await token1.balanceOf(wallet.address)).to.be.greaterThan(before);
  });

  it('swaps token1 for token0 and moves the price up', async () => {
    const { pool, caller, token0, wallet } = await initialized();

    const [priceBefore] = await pool.slot0();
    const before = await token0.balanceOf(wallet.address);

    await caller.swap(
      await pool.getAddress(),
      wallet.address,
      false,
      expandTo18Decimals(1) / 1000n,
      MAX_SQRT_RATIO - 1n
    );

    const [priceAfter, tickAfter] = await pool.slot0();
    expect(priceAfter).to.be.greaterThan(priceBefore);
    expect(tickAfter).to.be.greaterThan(0n);
    expect(await token0.balanceOf(wallet.address)).to.be.greaterThan(before);
  });

  it('accrues fees to the position and pays them out on collect', async () => {
    const { pool, caller, wallet } = await initialized();
    const tickLower = getMinTick(TICK_SPACING);
    const tickUpper = getMaxTick(TICK_SPACING);

    await caller.swap(
      await pool.getAddress(),
      wallet.address,
      true,
      expandTo18Decimals(1) / 100n,
      MIN_SQRT_RATIO + 1n
    );

    expect(await pool.feeGrowthGlobal0X128()).to.be.greaterThan(0n);

    // Burning zero pokes the position so tokensOwed picks up the accrued fees.
    await pool.burn(tickLower, tickUpper, 0);
    const key = ethers.keccak256(
      ethers.solidityPacked(['address', 'int24', 'int24'], [wallet.address, tickLower, tickUpper])
    );
    const position = await pool.positions(key);
    expect(position.tokensOwed0).to.be.greaterThan(0n);

    await expect(pool.collect(wallet.address, tickLower, tickUpper, position.tokensOwed0, position.tokensOwed1))
      .to.emit(pool, 'Collect');
  });

  it('rejects a swap past the price limit', async () => {
    const { pool, caller, wallet } = await initialized();
    await expect(
      caller.swap(await pool.getAddress(), wallet.address, true, expandTo18Decimals(1), MAX_SQRT_RATIO - 1n)
    ).to.be.revertedWith('SPL');
    await expect(
      caller.swap(await pool.getAddress(), wallet.address, true, 0n, MIN_SQRT_RATIO + 1n)
    ).to.be.revertedWith('AS');
  });

  it('serves oracle observations and grows cardinality', async () => {
    const { pool } = await initialized();

    const [tickCumulatives] = await pool.observe([0]);
    expect(tickCumulatives.length).to.equal(1);

    await expect(pool.increaseObservationCardinalityNext(5))
      .to.emit(pool, 'IncreaseObservationCardinalityNext')
      .withArgs(1n, 5n);
    const [, , , , cardinalityNext] = await pool.slot0();
    expect(cardinalityNext).to.equal(5n);
  });

  it('runs a flash loan and keeps the fee', async () => {
    const { pool, caller, token0, wallet } = await initialized();
    const poolBalanceBefore = await token0.balanceOf(await pool.getAddress());

    await caller.flash(await pool.getAddress(), await caller.getAddress(), expandTo18Decimals(1) / 1000n, 0);

    expect(await token0.balanceOf(await pool.getAddress())).to.be.greaterThan(poolBalanceBefore);
    expect(await pool.feeGrowthGlobal0X128()).to.be.greaterThan(0n);
  });

  it('restricts owner actions to the factory owner', async () => {
    const { pool, other, wallet } = await initialized();
    await expect(pool.connect(other).setFeeProtocol(4, 4)).to.be.reverted;
    await expect(pool.connect(other).collectProtocol(wallet.address, 0, 0)).to.be.reverted;

    await expect(pool.setFeeProtocol(4, 4)).to.emit(pool, 'SetFeeProtocol').withArgs(0n, 0n, 4n, 4n);
    await expect(pool.setFeeProtocol(3, 4)).to.be.reverted;
    await expect(pool.setFeeProtocol(11, 4)).to.be.reverted;
  });

  it('collects the protocol fee once it is switched on', async () => {
    const { pool, caller, wallet } = await initialized();
    await pool.setFeeProtocol(4, 4);

    await caller.swap(
      await pool.getAddress(),
      wallet.address,
      true,
      expandTo18Decimals(1) / 100n,
      MIN_SQRT_RATIO + 1n
    );

    const fees = await pool.protocolFees();
    expect(fees.token0).to.be.greaterThan(0n);
    await expect(pool.collectProtocol(wallet.address, fees.token0, fees.token1)).to.emit(pool, 'CollectProtocol');
  });

  it('burns liquidity back out of the position', async () => {
    const { pool, wallet } = await initialized();
    const tickLower = getMinTick(TICK_SPACING);
    const tickUpper = getMaxTick(TICK_SPACING);

    await expect(pool.burn(tickLower, tickUpper, expandTo18Decimals(1))).to.emit(pool, 'Burn');
    expect(await pool.liquidity()).to.equal(expandTo18Decimals(1));
  });
});
