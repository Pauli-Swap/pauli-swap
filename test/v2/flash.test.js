const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MINIMUM_LIQUIDITY, MaxUint256 } = require('../helpers');

async function fixture() {
  const [wallet, other] = await ethers.getSigners();
  const factory = await deploy('PauliV2Factory', [wallet.address], wallet);

  const tokenA = await deploy('TestSQRCTF1', [expandTo18Decimals(100000)], wallet);
  const tokenB = await deploy('TestSQRCTF1', [expandTo18Decimals(100000)], wallet);

  await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
  const pair = await ethers.getContractAt(
    artifactOf('PauliV2Pair').abi,
    await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress()),
    wallet
  );

  const token0Address = await pair.token0();
  const [token0, token1] = (await tokenA.getAddress()) === token0Address ? [tokenA, tokenB] : [tokenB, tokenA];

  const amount = expandTo18Decimals(100);
  await token0.transfer(await pair.getAddress(), amount);
  await token1.transfer(await pair.getAddress(), amount);
  await pair.mint(wallet.address);

  const borrower = await deploy('PauliV2FlashBorrower', [], wallet);
  await token0.approve(await borrower.getAddress(), MaxUint256);
  await token1.approve(await borrower.getAddress(), MaxUint256);

  return { factory, pair, token0, token1, borrower, wallet, other };
}

describe('PauliV2Pair flash swap', () => {
  it('lends token0 and accepts repayment in token1 inside the callback', async () => {
    const { pair, token0, token1, borrower, wallet } = await loadFixture(fixture);

    const borrowed = expandTo18Decimals(1);
    const before1 = await token1.balanceOf(wallet.address);

    await borrower.flashSwap(await pair.getAddress(), borrowed, 0);

    expect(await token0.balanceOf(await borrower.getAddress())).to.equal(borrowed);
    // The 0.3% fee is paid out of the caller's token1.
    expect(before1 - (await token1.balanceOf(wallet.address))).to.be.greaterThan(borrowed);
  });

  it('reverts the whole swap when the callback underpays by one wei', async () => {
    const { pair, borrower } = await loadFixture(fixture);

    await borrower.setRepayShort(true);
    await expect(borrower.flashSwap(await pair.getAddress(), expandTo18Decimals(1), 0)).to.be.revertedWith(
      'PauliV2: K'
    );
  });

  it('leaves reserves consistent with balances after a flash swap', async () => {
    const { pair, token0, token1, borrower } = await loadFixture(fixture);

    await borrower.flashSwap(await pair.getAddress(), expandTo18Decimals(1), 0);

    const [reserve0, reserve1] = await pair.getReserves();
    expect(reserve0).to.equal(await token0.balanceOf(await pair.getAddress()));
    expect(reserve1).to.equal(await token1.balanceOf(await pair.getAddress()));
  });
});

describe('PauliV2Pair invariants', () => {
  it('holds the lock against a reentrant call from the callback', async () => {
    const { pair, borrower } = await loadFixture(fixture);
    // The borrower re-enters through transferFrom on a token, not the pair, so
    // the direct check is that a nested swap on the locked pair reverts.
    const reentrant = await deploy('PauliV2ReentrancyProbe', [], (await ethers.getSigners())[0]);
    await expect(reentrant.attack(await pair.getAddress())).to.be.revertedWith('PauliV2: LOCKED');
    expect(await borrower.repayShort()).to.equal(false);
  });

  it('accumulates prices across several blocks', async () => {
    const { pair } = await loadFixture(fixture);

    const [, , startTimestamp] = await pair.getReserves();
    await time.setNextBlockTimestamp(Number(startTimestamp) + 10);
    await pair.sync();

    const first0 = await pair.price0CumulativeLast();
    expect(first0).to.equal(2n ** 112n * 10n);

    await time.setNextBlockTimestamp(Number(startTimestamp) + 30);
    await pair.sync();
    expect(await pair.price0CumulativeLast()).to.equal(2n ** 112n * 30n);
  });

  it('treats an infinite allowance as never decreasing', async () => {
    const { pair, wallet, other } = await loadFixture(fixture);

    await pair.approve(other.address, MaxUint256);
    await pair.connect(other).transferFrom(wallet.address, other.address, 1000n);

    expect(await pair.allowance(wallet.address, other.address)).to.equal(MaxUint256);
  });

  it('decrements a finite allowance and reverts once exhausted', async () => {
    const { pair, wallet, other } = await loadFixture(fixture);

    await pair.approve(other.address, 1000n);
    await pair.connect(other).transferFrom(wallet.address, other.address, 400n);
    expect(await pair.allowance(wallet.address, other.address)).to.equal(600n);

    await expect(pair.connect(other).transferFrom(wallet.address, other.address, 601n)).to.be.reverted;
  });

  it('permanently locks MINIMUM_LIQUIDITY at the zero address', async () => {
    const { pair } = await loadFixture(fixture);
    expect(await pair.balanceOf(ethers.ZeroAddress)).to.equal(MINIMUM_LIQUIDITY);
  });

  it('exposes no permit surface', async () => {
    const { pair } = await loadFixture(fixture);
    // Zond has no ecrecover, so EIP-2612 must be absent rather than reverting.
    const names = pair.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
    expect(names).to.not.include('permit');
    expect(names).to.not.include('DOMAIN_SEPARATOR');
    expect(names).to.not.include('nonces');
  });
});
