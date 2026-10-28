const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MINIMUM_LIQUIDITY, MaxUint256 } = require('../helpers');

async function fixture() {
  const [wallet, other] = await ethers.getSigners();

  const factory = await deploy('PauliV2Factory', [wallet.address], wallet);
  const wqrl = await deploy('WQRL', [], wallet);
  const router = await deploy(
    'PauliV2Router02',
    [await factory.getAddress(), await wqrl.getAddress()],
    wallet
  );

  const tokenA = await deploy('TestSQRCTF1', [expandTo18Decimals(100000)], wallet);
  const tokenB = await deploy('TestSQRCTF1', [expandTo18Decimals(100000)], wallet);
  const dtt = await deploy('DeflatingSQRCTF1', [expandTo18Decimals(100000)], wallet);

  for (const token of [tokenA, tokenB, dtt]) {
    await token.approve(await router.getAddress(), MaxUint256);
  }

  return { factory, router, wqrl, tokenA, tokenB, dtt, wallet, other };
}

const deadline = () => Math.floor(Date.now() / 1000) + 3600;

async function pairOf(factory, a, b) {
  return ethers.getContractAt(artifactOf('PauliV2Pair').abi, await factory.getPair(a, b));
}

describe('PauliV2Router02', () => {
  it('derives pair addresses off chain with the pinned init code hash', async () => {
    const { factory, router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    await router.addLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      expandTo18Decimals(1),
      expandTo18Decimals(4),
      0,
      0,
      wallet.address,
      deadline()
    );

    // If PAIR_INIT_CODE_HASH drifts from the compiled pair, every router entry
    // point silently targets an address with no code.
    const probe = await deploy('PauliV2LibraryProbe', [], wallet);
    expect(
      await probe.pairFor(
        await factory.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress()
      )
    ).to.equal(await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress()));
  });

  it('adds liquidity, creating the pair on demand', async () => {
    const { factory, router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    const amountA = expandTo18Decimals(1);
    const amountB = expandTo18Decimals(4);

    await router.addLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      amountA,
      amountB,
      0,
      0,
      wallet.address,
      deadline()
    );

    const pair = await pairOf(factory, await tokenA.getAddress(), await tokenB.getAddress());
    expect(await pair.balanceOf(wallet.address)).to.equal(expandTo18Decimals(2) - MINIMUM_LIQUIDITY);
  });

  it('enforces the optimal ratio bounds on a second deposit', async () => {
    const { router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    const args = [await tokenA.getAddress(), await tokenB.getAddress()];
    await router.addLiquidity(...args, expandTo18Decimals(1), expandTo18Decimals(4), 0, 0, wallet.address, deadline());

    await expect(
      router.addLiquidity(
        ...args,
        expandTo18Decimals(1),
        expandTo18Decimals(4),
        0,
        expandTo18Decimals(5),
        wallet.address,
        deadline()
      )
    ).to.be.revertedWith('PauliV2Router: INSUFFICIENT_B_AMOUNT');
  });

  it('rejects an expired deadline', async () => {
    const { router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    await expect(
      router.addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        expandTo18Decimals(1),
        expandTo18Decimals(1),
        0,
        0,
        wallet.address,
        1
      )
    ).to.be.revertedWith('PauliV2Router: EXPIRED');
  });

  it('removes liquidity back to the depositor', async () => {
    const { factory, router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    const args = [await tokenA.getAddress(), await tokenB.getAddress()];
    await router.addLiquidity(...args, expandTo18Decimals(1), expandTo18Decimals(4), 0, 0, wallet.address, deadline());

    const pair = await pairOf(factory, ...args);
    const liquidity = await pair.balanceOf(wallet.address);
    await pair.connect(wallet).approve(await router.getAddress(), MaxUint256);

    await router.removeLiquidity(...args, liquidity, 0, 0, wallet.address, deadline());
    expect(await pair.balanceOf(wallet.address)).to.equal(0n);
  });

  it('swaps an exact token amount along a two hop path', async () => {
    const { router, tokenA, tokenB, wallet, other } = await loadFixture(fixture);
    const args = [await tokenA.getAddress(), await tokenB.getAddress()];
    await router.addLiquidity(
      ...args,
      expandTo18Decimals(100),
      expandTo18Decimals(100),
      0,
      0,
      wallet.address,
      deadline()
    );

    const amountIn = expandTo18Decimals(1);
    const path = [await tokenA.getAddress(), await tokenB.getAddress()];
    const [, expectedOut] = await router.getAmountsOut(amountIn, path);

    const before = await tokenB.balanceOf(other.address);
    await router.swapExactTokensForTokens(amountIn, expectedOut, path, other.address, deadline());
    expect((await tokenB.balanceOf(other.address)) - before).to.equal(expectedOut);
  });

  it('rejects a swap whose output falls below the minimum', async () => {
    const { router, tokenA, tokenB, wallet } = await loadFixture(fixture);
    const args = [await tokenA.getAddress(), await tokenB.getAddress()];
    await router.addLiquidity(
      ...args,
      expandTo18Decimals(100),
      expandTo18Decimals(100),
      0,
      0,
      wallet.address,
      deadline()
    );

    const path = [await tokenA.getAddress(), await tokenB.getAddress()];
    const amountIn = expandTo18Decimals(1);
    const [, expectedOut] = await router.getAmountsOut(amountIn, path);

    await expect(
      router.swapExactTokensForTokens(amountIn, expectedOut + 1n, path, wallet.address, deadline())
    ).to.be.revertedWith('PauliV2Router: INSUFFICIENT_OUTPUT_AMOUNT');
  });

  it('wraps and unwraps native QRL through WQRL', async () => {
    const { router, wqrl, tokenA, wallet } = await loadFixture(fixture);

    await router.addLiquidityQRL(
      await tokenA.getAddress(),
      expandTo18Decimals(10),
      0,
      0,
      wallet.address,
      deadline(),
      { value: expandTo18Decimals(10) }
    );

    const path = [await wqrl.getAddress(), await tokenA.getAddress()];
    const amountIn = expandTo18Decimals(1);
    const [, expectedOut] = await router.getAmountsOut(amountIn, path);

    const before = await tokenA.balanceOf(wallet.address);
    await router.swapExactQRLForTokens(expectedOut, path, wallet.address, deadline(), { value: amountIn });
    expect((await tokenA.balanceOf(wallet.address)) - before).to.equal(expectedOut);

    const reversePath = [await tokenA.getAddress(), await wqrl.getAddress()];
    await router.swapExactTokensForQRL(expandTo18Decimals(1), 0, reversePath, wallet.address, deadline());
  });

  it('routes a fee-on-transfer token through the supporting entry point', async () => {
    const { router, dtt, wqrl, wallet } = await loadFixture(fixture);

    await router.addLiquidityQRL(
      await dtt.getAddress(),
      expandTo18Decimals(100),
      0,
      0,
      wallet.address,
      deadline(),
      { value: expandTo18Decimals(100) }
    );

    const path = [await dtt.getAddress(), await wqrl.getAddress()];
    const amountIn = expandTo18Decimals(1);

    // The plain entry point cannot work: the pair receives less than amountIn.
    await expect(
      router.swapExactTokensForQRL(amountIn, 0, path, wallet.address, deadline())
    ).to.be.reverted;

    await router.swapExactTokensForQRLSupportingFeeOnTransferTokens(
      amountIn,
      0,
      path,
      wallet.address,
      deadline()
    );
  });

  it('reverts a direct native transfer from anyone but WQRL', async () => {
    const { router, wallet } = await loadFixture(fixture);
    await expect(
      wallet.sendTransaction({ to: await router.getAddress(), value: 1n })
    ).to.be.reverted;
  });
});
