const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MINIMUM_LIQUIDITY } = require('../helpers');

async function fixture() {
  const [wallet, other] = await ethers.getSigners();
  const factory = await deploy('HyperionV2Factory', [wallet.address], wallet);

  const tokenA = await deploy('TestSQRCTF1', [expandTo18Decimals(10000)], wallet);
  const tokenB = await deploy('TestSQRCTF1', [expandTo18Decimals(10000)], wallet);

  await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
  const pair = await ethers.getContractAt(
    artifactOf('HyperionV2Pair').abi,
    await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress()),
    wallet
  );

  const token0Address = await pair.token0();
  const [token0, token1] =
    (await tokenA.getAddress()) === token0Address ? [tokenA, tokenB] : [tokenB, tokenA];

  return { factory, pair, token0, token1, wallet, other };
}

async function addLiquidity(pair, token0, token1, amount0, amount1, to) {
  await token0.transfer(await pair.getAddress(), amount0);
  await token1.transfer(await pair.getAddress(), amount1);
  await pair.mint(to);
}

describe('HyperionV2Pair', () => {
  it('mints the geometric mean minus the locked minimum on first deposit', async () => {
    const { pair, token0, token1, wallet } = await loadFixture(fixture);
    const amount0 = expandTo18Decimals(1);
    const amount1 = expandTo18Decimals(4);
    const expectedLiquidity = expandTo18Decimals(2);

    await token0.transfer(await pair.getAddress(), amount0);
    await token1.transfer(await pair.getAddress(), amount1);

    await expect(pair.mint(wallet.address))
      .to.emit(pair, 'Transfer')
      .withArgs(ethers.ZeroAddress, ethers.ZeroAddress, MINIMUM_LIQUIDITY)
      .to.emit(pair, 'Transfer')
      .withArgs(ethers.ZeroAddress, wallet.address, expectedLiquidity - MINIMUM_LIQUIDITY)
      .to.emit(pair, 'Sync')
      .withArgs(amount0, amount1)
      .to.emit(pair, 'Mint')
      .withArgs(wallet.address, amount0, amount1);

    expect(await pair.totalSupply()).to.equal(expectedLiquidity);
    expect(await pair.balanceOf(wallet.address)).to.equal(expectedLiquidity - MINIMUM_LIQUIDITY);
    expect(await pair.balanceOf(ethers.ZeroAddress)).to.equal(MINIMUM_LIQUIDITY);
    const [reserve0, reserve1] = await pair.getReserves();
    expect(reserve0).to.equal(amount0);
    expect(reserve1).to.equal(amount1);
  });

  const swapCases = [
    [1, 5, 10, '1662497915624478906'],
    [1, 10, 5, '453305446940074565'],
    [2, 5, 10, '2851015155847869602'],
    [2, 10, 5, '831248957812239453'],
    [1, 10, 10, '906610893880149131'],
    [1, 100, 100, '987158034397061298'],
    [1, 1000, 1000, '996006981039903216'],
  ];

  swapCases.forEach(([swapAmount, token0Amount, token1Amount, expectedOutput], i) => {
    it(`prices swap case ${i} exactly as Uniswap V2 does`, async () => {
      const { pair, token0, token1, wallet } = await loadFixture(fixture);
      await addLiquidity(
        pair,
        token0,
        token1,
        expandTo18Decimals(token0Amount),
        expandTo18Decimals(token1Amount),
        wallet.address
      );
      await token0.transfer(await pair.getAddress(), expandTo18Decimals(swapAmount));

      await expect(pair.swap(0, BigInt(expectedOutput) + 1n, wallet.address, '0x')).to.be.revertedWith(
        'HyperionV2: K'
      );
      await pair.swap(0, BigInt(expectedOutput), wallet.address, '0x');
    });
  });

  it('emits Swap and moves reserves on a token0 in swap', async () => {
    const { pair, token0, token1, wallet } = await loadFixture(fixture);
    const token0Amount = expandTo18Decimals(5);
    const token1Amount = expandTo18Decimals(10);
    await addLiquidity(pair, token0, token1, token0Amount, token1Amount, wallet.address);

    const swapAmount = expandTo18Decimals(1);
    const expectedOutput = 1662497915624478906n;
    await token0.transfer(await pair.getAddress(), swapAmount);

    await expect(pair.swap(0, expectedOutput, wallet.address, '0x'))
      .to.emit(token1, 'Transfer')
      .withArgs(await pair.getAddress(), wallet.address, expectedOutput)
      .to.emit(pair, 'Sync')
      .withArgs(token0Amount + swapAmount, token1Amount - expectedOutput)
      .to.emit(pair, 'Swap')
      .withArgs(wallet.address, swapAmount, 0, 0, expectedOutput, wallet.address);

    const [reserve0, reserve1] = await pair.getReserves();
    expect(reserve0).to.equal(token0Amount + swapAmount);
    expect(reserve1).to.equal(token1Amount - expectedOutput);
  });

  it('burns liquidity back to the underlying tokens', async () => {
    const { pair, token0, token1, wallet } = await loadFixture(fixture);
    const amount = expandTo18Decimals(3);
    await addLiquidity(pair, token0, token1, amount, amount, wallet.address);

    const expectedLiquidity = expandTo18Decimals(3);
    await pair.transfer(await pair.getAddress(), expectedLiquidity - MINIMUM_LIQUIDITY);

    await expect(pair.burn(wallet.address))
      .to.emit(pair, 'Transfer')
      .withArgs(await pair.getAddress(), ethers.ZeroAddress, expectedLiquidity - MINIMUM_LIQUIDITY)
      .to.emit(pair, 'Sync')
      .withArgs(MINIMUM_LIQUIDITY, MINIMUM_LIQUIDITY)
      .to.emit(pair, 'Burn');

    expect(await pair.balanceOf(wallet.address)).to.equal(0n);
    expect(await pair.totalSupply()).to.equal(MINIMUM_LIQUIDITY);
  });

  it('accumulates prices with wrapping arithmetic', async () => {
    const { pair, token0, token1, wallet } = await loadFixture(fixture);
    const amount = expandTo18Decimals(3);
    await addLiquidity(pair, token0, token1, amount, amount, wallet.address);

    const [, , initialTimestamp] = await pair.getReserves();
    await time.setNextBlockTimestamp(Number(initialTimestamp) + 1);
    await pair.sync();

    const q112 = 2n ** 112n;
    expect(await pair.price0CumulativeLast()).to.equal(q112);
    expect(await pair.price1CumulativeLast()).to.equal(q112);
    const [, , afterTimestamp] = await pair.getReserves();
    expect(afterTimestamp).to.equal(Number(initialTimestamp) + 1);
  });

  it('mints the protocol fee to feeTo when it is switched on', async () => {
    const { factory, pair, token0, token1, wallet, other } = await loadFixture(fixture);
    await factory.setFeeTo(other.address);

    const amount = expandTo18Decimals(1000);
    await addLiquidity(pair, token0, token1, amount, amount, wallet.address);

    const swapAmount = expandTo18Decimals(1);
    const expectedOutput = 996006981039903216n;
    await token1.transfer(await pair.getAddress(), swapAmount);
    await pair.swap(expectedOutput, 0, wallet.address, '0x');

    const expectedLiquidity = expandTo18Decimals(1000);
    await pair.transfer(await pair.getAddress(), expectedLiquidity - MINIMUM_LIQUIDITY);
    await pair.burn(wallet.address);

    expect(await pair.balanceOf(other.address)).to.be.greaterThan(0n);
    expect(await pair.totalSupply()).to.equal(MINIMUM_LIQUIDITY + (await pair.balanceOf(other.address)));
  });

  it('rejects a swap that drains a reserve or targets a pool token', async () => {
    const { pair, token0, token1, wallet } = await loadFixture(fixture);
    const amount = expandTo18Decimals(5);
    await addLiquidity(pair, token0, token1, amount, amount, wallet.address);

    await expect(pair.swap(0, 0, wallet.address, '0x')).to.be.revertedWith(
      'HyperionV2: INSUFFICIENT_OUTPUT_AMOUNT'
    );
    await expect(pair.swap(0, amount, wallet.address, '0x')).to.be.revertedWith(
      'HyperionV2: INSUFFICIENT_LIQUIDITY'
    );
    await expect(pair.swap(0, 1n, await token0.getAddress(), '0x')).to.be.revertedWith(
      'HyperionV2: INVALID_TO'
    );
  });

  it('lets skim and sync recover a donation mismatch', async () => {
    const { pair, token0, token1, wallet, other } = await loadFixture(fixture);
    const amount = expandTo18Decimals(5);
    await addLiquidity(pair, token0, token1, amount, amount, wallet.address);

    const donation = expandTo18Decimals(1);
    await token0.transfer(await pair.getAddress(), donation);

    await pair.skim(other.address);
    expect(await token0.balanceOf(other.address)).to.equal(donation);

    await token0.transfer(await pair.getAddress(), donation);
    await pair.sync();
    const [reserve0] = await pair.getReserves();
    expect(reserve0).to.equal(amount + donation);
  });

  it('refuses re-initialisation by anyone but the factory', async () => {
    const { pair, wallet } = await loadFixture(fixture);
    await expect(pair.initialize(wallet.address, wallet.address)).to.be.revertedWith(
      'HyperionV2: FORBIDDEN'
    );
  });
});
