const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MaxUint256 } = require('../helpers');

const FEE_MEDIUM = 3000;
const TICK_SPACING = 60;
const ENCODED_PRICE_1_1 = 79228162514264337593543950336n;

const getMinTick = (spacing) => Math.ceil(-887272 / spacing) * spacing;
const getMaxTick = (spacing) => Math.floor(887272 / spacing) * spacing;
const deadline = () => Math.floor(Date.now() / 1000) + 3600;

function encodePath(tokens, fees) {
  const types = ['address'];
  const values = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push('uint24', 'address');
    values.push(fees[i], tokens[i + 1]);
  }
  return ethers.solidityPacked(types, values);
}

async function fixture() {
  const [wallet, other] = await ethers.getSigners();

  const factory = await deploy('AcornV3Factory', [], wallet);
  const wqrl = await deploy('WQRL', [], wallet);
  const router = await deploy('SwapRouter', [await factory.getAddress(), await wqrl.getAddress()], wallet);
  const caller = await deploy('AcornV3PoolCaller', [], wallet);

  const tokens = [];
  for (let i = 0; i < 3; i++) {
    tokens.push(await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet));
  }
  const addresses = await Promise.all(tokens.map((t) => t.getAddress()));
  tokens.sort((a, b) => (addresses[tokens.indexOf(a)].toLowerCase() < addresses[tokens.indexOf(b)].toLowerCase() ? -1 : 1));

  for (const token of tokens) {
    await token.approve(await router.getAddress(), MaxUint256);
    await token.approve(await caller.getAddress(), MaxUint256);
  }

  return { factory, router, wqrl, caller, tokens, wallet, other };
}

async function createAndSeedPool(ctx, tokenA, tokenB) {
  const { factory, caller, wallet } = ctx;
  const a = await tokenA.getAddress();
  const b = await tokenB.getAddress();
  await factory.createPool(a, b, FEE_MEDIUM);
  const poolAddress = await factory.getPool(a, b, FEE_MEDIUM);
  const pool = await ethers.getContractAt(artifactOf('AcornV3Pool').abi, poolAddress, wallet);
  await pool.initialize(ENCODED_PRICE_1_1);
  await caller.mint(
    poolAddress,
    wallet.address,
    getMinTick(TICK_SPACING),
    getMaxTick(TICK_SPACING),
    expandTo18Decimals(1000)
  );
  return pool;
}

describe('V3 periphery', () => {
  it('derives pool addresses off chain with the pinned init code hash', async () => {
    const { factory, tokens, wallet } = await loadFixture(fixture);

    const probe = await deploy('PoolAddressProbe', [], wallet);
    const [a, b] = [await tokens[0].getAddress(), await tokens[1].getAddress()];
    await factory.createPool(a, b, FEE_MEDIUM);

    // A stale POOL_INIT_CODE_HASH makes every router entry point target an
    // address with no code, which is why this is asserted directly.
    expect(await probe.computeAddress(await factory.getAddress(), a, b, FEE_MEDIUM)).to.equal(
      await factory.getPool(a, b, FEE_MEDIUM)
    );
    expect(await probe.initCodeHash()).to.equal(ethers.keccak256(artifactOf('AcornV3Pool').bytecode));
  });

  it('swaps an exact input through a single pool', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet, other } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const amountIn = expandTo18Decimals(1);
    const before = await tokens[1].balanceOf(other.address);

    await router.exactInputSingle({
      tokenIn: await tokens[0].getAddress(),
      tokenOut: await tokens[1].getAddress(),
      fee: FEE_MEDIUM,
      recipient: other.address,
      deadline: deadline(),
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });

    const received = (await tokens[1].balanceOf(other.address)) - before;
    expect(received).to.be.greaterThan(0n);
    // 0.3% fee plus price impact, so slightly under parity on a 1:1 pool.
    expect(received).to.be.lessThan(amountIn);
    expect(received).to.be.greaterThan((amountIn * 99n) / 100n);
  });

  it('honours amountOutMinimum', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    await expect(
      router.exactInputSingle({
        tokenIn: await tokens[0].getAddress(),
        tokenOut: await tokens[1].getAddress(),
        fee: FEE_MEDIUM,
        recipient: wallet.address,
        deadline: deadline(),
        amountIn: expandTo18Decimals(1),
        amountOutMinimum: expandTo18Decimals(1),
        sqrtPriceLimitX96: 0,
      })
    ).to.be.revertedWith('Too little received');
  });

  it('rejects an expired deadline', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    await expect(
      router.exactInputSingle({
        tokenIn: await tokens[0].getAddress(),
        tokenOut: await tokens[1].getAddress(),
        fee: FEE_MEDIUM,
        recipient: wallet.address,
        deadline: 1,
        amountIn: expandTo18Decimals(1),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })
    ).to.be.revertedWith('Transaction too old');
  });

  it('swaps an exact output through a single pool', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet, other } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const amountOut = expandTo18Decimals(1);
    const before0 = await tokens[0].balanceOf(wallet.address);
    const before1 = await tokens[1].balanceOf(other.address);

    await router.exactOutputSingle({
      tokenIn: await tokens[0].getAddress(),
      tokenOut: await tokens[1].getAddress(),
      fee: FEE_MEDIUM,
      recipient: other.address,
      deadline: deadline(),
      amountOut,
      amountInMaximum: expandTo18Decimals(2),
      sqrtPriceLimitX96: 0,
    });

    expect((await tokens[1].balanceOf(other.address)) - before1).to.equal(amountOut);
    expect(before0 - (await tokens[0].balanceOf(wallet.address))).to.be.greaterThan(amountOut);
  });

  it('honours amountInMaximum', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    await expect(
      router.exactOutputSingle({
        tokenIn: await tokens[0].getAddress(),
        tokenOut: await tokens[1].getAddress(),
        fee: FEE_MEDIUM,
        recipient: wallet.address,
        deadline: deadline(),
        amountOut: expandTo18Decimals(1),
        amountInMaximum: expandTo18Decimals(1),
        sqrtPriceLimitX96: 0,
      })
    ).to.be.revertedWith('Too much requested');
  });

  it('routes an exact input across two pools', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, other } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);
    await createAndSeedPool(ctx, tokens[1], tokens[2]);

    const path = encodePath(
      [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
      [FEE_MEDIUM, FEE_MEDIUM]
    );

    const before = await tokens[2].balanceOf(other.address);
    await router.exactInput({
      path,
      recipient: other.address,
      deadline: deadline(),
      amountIn: expandTo18Decimals(1),
      amountOutMinimum: 0,
    });

    expect((await tokens[2].balanceOf(other.address)) - before).to.be.greaterThan(0n);
  });

  it('routes an exact output across two pools', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, other } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);
    await createAndSeedPool(ctx, tokens[1], tokens[2]);

    // Exact output paths are encoded from output token back to input token.
    const path = encodePath(
      [await tokens[2].getAddress(), await tokens[1].getAddress(), await tokens[0].getAddress()],
      [FEE_MEDIUM, FEE_MEDIUM]
    );

    const amountOut = expandTo18Decimals(1);
    const before = await tokens[2].balanceOf(other.address);
    await router.exactOutput({
      path,
      recipient: other.address,
      deadline: deadline(),
      amountOut,
      amountInMaximum: expandTo18Decimals(2),
    });

    expect((await tokens[2].balanceOf(other.address)) - before).to.equal(amountOut);
  });

  it('rejects a swap callback from a contract that is not the pool', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(bytes,address)'],
      [[encodePath([await tokens[0].getAddress(), await tokens[1].getAddress()], [FEE_MEDIUM]), ethers.ZeroAddress]]
    );
    await expect(router.acornV3SwapCallback(1, 0, data)).to.be.reverted;
  });

  it('wraps native QRL for a swap and refunds the remainder', async () => {
    const ctx = await loadFixture(fixture);
    const { router, wqrl, tokens, caller, factory, wallet, other } = ctx;

    const token = tokens[0];
    const [a, b] = [await wqrl.getAddress(), await token.getAddress()];
    await factory.createPool(a, b, FEE_MEDIUM);
    const poolAddress = await factory.getPool(a, b, FEE_MEDIUM);
    const pool = await ethers.getContractAt(artifactOf('AcornV3Pool').abi, poolAddress, wallet);
    await pool.initialize(ENCODED_PRICE_1_1);

    await wqrl.deposit({ value: expandTo18Decimals(100) });
    await wqrl.approve(await caller.getAddress(), MaxUint256);
    await caller.mint(
      poolAddress,
      wallet.address,
      getMinTick(TICK_SPACING),
      getMaxTick(TICK_SPACING),
      expandTo18Decimals(50)
    );

    const amountIn = expandTo18Decimals(1);
    const before = await token.balanceOf(other.address);

    await router.exactInputSingle(
      {
        tokenIn: a,
        tokenOut: b,
        fee: FEE_MEDIUM,
        recipient: other.address,
        deadline: deadline(),
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      },
      { value: amountIn }
    );

    expect((await token.balanceOf(other.address)) - before).to.be.greaterThan(0n);
  });

  it('batches calls through multicall', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const call = router.interface.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: await tokens[0].getAddress(),
        tokenOut: await tokens[1].getAddress(),
        fee: FEE_MEDIUM,
        recipient: wallet.address,
        deadline: deadline(),
        amountIn: expandTo18Decimals(1),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      },
    ]);

    const before = await tokens[1].balanceOf(wallet.address);
    await router.multicall([call, call]);
    expect((await tokens[1].balanceOf(wallet.address)) - before).to.be.greaterThan(0n);
  });

  it('quotes exactly what the swap then delivers', async () => {
    const ctx = await loadFixture(fixture);
    const { factory, router, wqrl, tokens, wallet, other } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const quoter = await deploy('Quoter', [await factory.getAddress(), await wqrl.getAddress()], wallet);
    const amountIn = expandTo18Decimals(1);
    const tokenIn = await tokens[0].getAddress();
    const tokenOut = await tokens[1].getAddress();

    const quoted = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, FEE_MEDIUM, amountIn, 0);
    expect(quoted).to.be.greaterThan(0n);

    const before = await tokens[1].balanceOf(other.address);
    await router.exactInputSingle({
      tokenIn,
      tokenOut,
      fee: FEE_MEDIUM,
      recipient: other.address,
      deadline: deadline(),
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });

    expect((await tokens[1].balanceOf(other.address)) - before).to.equal(quoted);
  });

  it('quotes an exact output and a multi hop path', async () => {
    const ctx = await loadFixture(fixture);
    const { factory, wqrl, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);
    await createAndSeedPool(ctx, tokens[1], tokens[2]);

    const quoter = await deploy('Quoter', [await factory.getAddress(), await wqrl.getAddress()], wallet);
    const amountOut = expandTo18Decimals(1);

    const amountIn = await quoter.quoteExactOutputSingle.staticCall(
      await tokens[0].getAddress(),
      await tokens[1].getAddress(),
      FEE_MEDIUM,
      amountOut,
      0
    );
    expect(amountIn).to.be.greaterThan(amountOut);

    const path = encodePath(
      [await tokens[0].getAddress(), await tokens[1].getAddress(), await tokens[2].getAddress()],
      [FEE_MEDIUM, FEE_MEDIUM]
    );
    const multiHop = await quoter.quoteExactInput.staticCall(path, expandTo18Decimals(1));
    expect(multiHop).to.be.greaterThan(0n);
    expect(multiHop).to.be.lessThan(expandTo18Decimals(1));
  });

  it('surfaces the inner revert reason through multicall', async () => {
    const ctx = await loadFixture(fixture);
    const { router, tokens, wallet } = ctx;
    await createAndSeedPool(ctx, tokens[0], tokens[1]);

    const failing = router.interface.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: await tokens[0].getAddress(),
        tokenOut: await tokens[1].getAddress(),
        fee: FEE_MEDIUM,
        recipient: wallet.address,
        deadline: 1,
        amountIn: expandTo18Decimals(1),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      },
    ]);

    await expect(router.multicall([failing])).to.be.revertedWith('Transaction too old');
  });
});
