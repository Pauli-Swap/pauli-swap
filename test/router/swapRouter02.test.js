const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf, expandTo18Decimals, MaxUint256, deadline, latestTimestamp } = require('../helpers');

const FEE_MEDIUM = 3000;
const TICK_SPACING = 60;
const ENCODED_PRICE_1_1 = 79228162514264337593543950336n;
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const FEE_BIPS = 25n;

const getMinTick = (spacing) => Math.ceil(-887272 / spacing) * spacing;
const getMaxTick = (spacing) => Math.floor(887272 / spacing) * spacing;

function encodePath(tokens, fees) {
  const types = ['address'];
  const values = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push('uint24', 'address');
    values.push(fees[i], tokens[i + 1]);
  }
  return ethers.solidityPacked(types, values);
}

/// Tokens X < Y < Z, a V2 pair X/Y and Y/Z, a V3 pool for each adjacent pair
/// and WQRL/X on both protocols, all at 1:1. The old routers are deployed next
/// to SwapRouter02 so each swap can be compared with what they return.
async function fixture() {
  const [wallet, other, treasury] = await ethers.getSigners();

  const wqrl = await deploy('WQRL', [], wallet);
  const v2Factory = await deploy('PauliV2Factory', [wallet.address], wallet);
  const v2Router = await deploy('PauliV2Router02', [await v2Factory.getAddress(), await wqrl.getAddress()], wallet);
  const v3Factory = await deploy('PauliV3Factory', [], wallet);
  const v3Router = await deploy('SwapRouter', [await v3Factory.getAddress(), await wqrl.getAddress()], wallet);
  const router = await deploy(
    'SwapRouter02',
    [await v2Factory.getAddress(), await v3Factory.getAddress(), await wqrl.getAddress()],
    wallet
  );
  const caller = await deploy('PauliV3PoolCaller', [], wallet);

  const tokens = [];
  for (let i = 0; i < 3; i++) tokens.push(await deploy('TestSQRCTF1', [expandTo18Decimals(1000000)], wallet));
  const keyed = await Promise.all(tokens.map(async (t) => [(await t.getAddress()).toLowerCase(), t]));
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const [X, Y, Z] = keyed.map(([, t]) => t);
  const deflating = await deploy('DeflatingSQRCTF1', [expandTo18Decimals(1000000)], wallet);

  await wqrl.deposit({ value: expandTo18Decimals(3000) });
  for (const token of [X, Y, Z, deflating, wqrl]) {
    for (const spender of [v2Router, v3Router, router, caller]) await token.approve(await spender.getAddress(), MaxUint256);
  }

  const ctx = { wallet, other, treasury, wqrl, v2Factory, v2Router, v3Factory, v3Router, router, caller, X, Y, Z, deflating };
  const add = async (a, b) =>
    v2Router.addLiquidity(
      await a.getAddress(),
      await b.getAddress(),
      expandTo18Decimals(1000),
      expandTo18Decimals(1000),
      0,
      0,
      wallet.address,
      await deadline()
    );
  await add(X, Y);
  await add(Y, Z);
  await add(wqrl, X);
  await add(deflating, Y);
  for (const [a, b] of [[X, Y], [Y, Z], [wqrl, X]]) await createAndSeedPool(ctx, a, b);
  return ctx;
}

async function createAndSeedPool({ v3Factory, caller, wallet }, tokenA, tokenB) {
  const a = await tokenA.getAddress();
  const b = await tokenB.getAddress();
  await v3Factory.createPool(a, b, FEE_MEDIUM);
  const pool = await ethers.getContractAt(artifactOf('PauliV3Pool').abi, await v3Factory.getPool(a, b, FEE_MEDIUM), wallet);
  await pool.initialize(ENCODED_PRICE_1_1);
  await caller.mint(await pool.getAddress(), wallet.address, getMinTick(TICK_SPACING), getMaxTick(TICK_SPACING), expandTo18Decimals(1000));
  return pool;
}

const call = (router, name, args) => router.interface.encodeFunctionData(name, args);
const balance = (token, who) => token.balanceOf(who.address ?? who);

describe('SwapRouter02', () => {
  describe('V2', () => {
    it('swaps an exact input for what PauliV2Router02 quotes', async () => {
      const { router, v2Router, X, Y, Z, other } = await loadFixture(fixture);
      const path = [await X.getAddress(), await Y.getAddress(), await Z.getAddress()];
      const amountIn = expandTo18Decimals(3);
      const [, , quoted] = await v2Router.getAmountsOut(amountIn, path);

      const before = await balance(Z, other);
      await router.swapExactTokensForTokens(amountIn, quoted, path, other.address);
      expect((await balance(Z, other)) - before).to.equal(quoted);
    });

    it('swaps for an exact output at the amount in PauliV2Router02 quotes', async () => {
      const { router, v2Router, wallet, X, Y } = await loadFixture(fixture);
      const path = [await X.getAddress(), await Y.getAddress()];
      const amountOut = expandTo18Decimals(2);
      const [needed] = await v2Router.getAmountsIn(amountOut, path);

      const xBefore = await balance(X, wallet);
      const yBefore = await balance(Y, wallet);
      await router.swapTokensForExactTokens(amountOut, needed, path, MSG_SENDER);
      expect(xBefore - (await balance(X, wallet))).to.equal(needed);
      expect((await balance(Y, wallet)) - yBefore).to.equal(amountOut);
    });

    it('rejects too little received and too much requested', async () => {
      const { router, v2Router, X, Y, wallet } = await loadFixture(fixture);
      const path = [await X.getAddress(), await Y.getAddress()];
      const [, out] = await v2Router.getAmountsOut(expandTo18Decimals(1), path);
      await expect(router.swapExactTokensForTokens(expandTo18Decimals(1), out + 1n, path, wallet.address)).to.be.revertedWith(
        'Too little received'
      );
      const [needed] = await v2Router.getAmountsIn(expandTo18Decimals(1), path);
      await expect(router.swapTokensForExactTokens(expandTo18Decimals(1), needed - 1n, path, wallet.address)).to.be.revertedWith(
        'Too much requested'
      );
    });

    it('measures a fee-on-transfer input instead of trusting amountIn', async () => {
      const { router, v2Router, deflating, Y, other } = await loadFixture(fixture);
      const path = [await deflating.getAddress(), await Y.getAddress()];
      const amountIn = expandTo18Decimals(1);
      // The pair receives 99% of amountIn; the old router's supporting call is the reference.
      const snapshot = await ethers.provider.send('evm_snapshot', []);
      const ref = await balance(Y, other);
      await v2Router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, other.address, await deadline());
      const expected = (await balance(Y, other)) - ref;
      await ethers.provider.send('evm_revert', [snapshot]);

      const before = await balance(Y, other);
      await router.swapExactTokensForTokens(amountIn, expected, path, other.address);
      expect((await balance(Y, other)) - before).to.equal(expected);
    });
  });

  describe('V3', () => {
    it('matches SwapRouter on exactInputSingle and exactOutput', async () => {
      const { router, v3Router, X, Y, Z, wallet } = await loadFixture(fixture);
      const [x, y, z] = [await X.getAddress(), await Y.getAddress(), await Z.getAddress()];
      const amount = expandTo18Decimals(5);

      const snapshot = await ethers.provider.send('evm_snapshot', []);
      let before = await balance(Y, wallet);
      await v3Router.exactInputSingle({
        tokenIn: x, tokenOut: y, fee: FEE_MEDIUM, recipient: wallet.address, deadline: await deadline(),
        amountIn: amount, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      });
      const refOut = (await balance(Y, wallet)) - before;
      before = await balance(X, wallet);
      await v3Router.exactOutput({
        path: encodePath([z, y, x], [FEE_MEDIUM, FEE_MEDIUM]), recipient: wallet.address, deadline: await deadline(),
        amountOut: amount, amountInMaximum: MaxUint256,
      });
      const refIn = before - (await balance(X, wallet));
      await ethers.provider.send('evm_revert', [snapshot]);

      before = await balance(Y, wallet);
      await router.exactInputSingle({
        tokenIn: x, tokenOut: y, fee: FEE_MEDIUM, recipient: MSG_SENDER, amountIn: amount, amountOutMinimum: refOut, sqrtPriceLimitX96: 0,
      });
      expect((await balance(Y, wallet)) - before).to.equal(refOut);
      before = await balance(X, wallet);
      await router.exactOutput({ path: encodePath([z, y, x], [FEE_MEDIUM, FEE_MEDIUM]), recipient: MSG_SENDER, amountOut: amount, amountInMaximum: refIn });
      expect(before - (await balance(X, wallet))).to.equal(refIn);
    });

    it('rejects a callback that does not come from a pool', async () => {
      const { router, X, Y, wallet } = await loadFixture(fixture);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(bytes,address)'],
        [[encodePath([await X.getAddress(), await Y.getAddress()], [FEE_MEDIUM]), wallet.address]]
      );
      await expect(router.pauliV3SwapCallback(1, 0, data)).to.be.reverted;
    });
  });

  describe('interface fee', () => {
    it('takes feeBips of the output for the fee recipient and nothing from a direct swap', async () => {
      const { router, X, Y, other, treasury } = await loadFixture(fixture);
      const [x, y] = [await X.getAddress(), await Y.getAddress()];
      const amountIn = expandTo18Decimals(4);

      const snapshot = await ethers.provider.send('evm_snapshot', []);
      let before = await balance(Y, other);
      await router.exactInputSingle({ tokenIn: x, tokenOut: y, fee: FEE_MEDIUM, recipient: other.address, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 });
      const gross = (await balance(Y, other)) - before;
      expect(await balance(Y, treasury)).to.equal(0n);
      await ethers.provider.send('evm_revert', [snapshot]);

      before = await balance(Y, other);
      await router.multicall(await deadline(), [
        call(router, 'exactInputSingle', [{ tokenIn: x, tokenOut: y, fee: FEE_MEDIUM, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: gross, sqrtPriceLimitX96: 0 }]),
        call(router, 'sweepTokenWithFee', [y, gross, other.address, FEE_BIPS, treasury.address]),
      ]);
      const fee = (gross * FEE_BIPS) / 10_000n;
      expect(await balance(Y, treasury)).to.equal(fee);
      expect((await balance(Y, other)) - before).to.equal(gross - fee);
      expect(await balance(Y, router)).to.equal(0n);
    });

    it('takes the fee in QRL when unwrapping the output', async () => {
      const { router, wqrl, X, other, treasury } = await loadFixture(fixture);
      const amountIn = expandTo18Decimals(2);
      const otherBefore = await ethers.provider.getBalance(other.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await router.multicall(await deadline(), [
        call(router, 'swapExactTokensForTokens', [amountIn, 0, [await X.getAddress(), await wqrl.getAddress()], ADDRESS_THIS]),
        call(router, 'unwrapWQRL9WithFee', [0, other.address, FEE_BIPS, treasury.address]),
      ]);
      const fee = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;
      const net = (await ethers.provider.getBalance(other.address)) - otherBefore;
      expect(fee).to.equal(((fee + net) * FEE_BIPS) / 10_000n);
      expect(net).to.be.greaterThan(0n);
      expect(await balance(wqrl, router)).to.equal(0n);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
    });

    it('accepts native QRL in and refunds what an exact output did not spend', async () => {
      const { router, wqrl, X, wallet } = await loadFixture(fixture);
      const [w, x] = [await wqrl.getAddress(), await X.getAddress()];
      const before = await balance(X, wallet);
      await router.multicall(
        await deadline(),
        [
          call(router, 'exactOutputSingle', [{ tokenIn: w, tokenOut: x, fee: FEE_MEDIUM, recipient: MSG_SENDER, amountOut: expandTo18Decimals(1), amountInMaximum: expandTo18Decimals(2), sqrtPriceLimitX96: 0 }]),
          call(router, 'refundQRL', []),
        ],
        { value: expandTo18Decimals(2) }
      );
      expect((await balance(X, wallet)) - before).to.equal(expandTo18Decimals(1));
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
    });

    it('rejects a fee of 0 or above 100 bips and a short sweep', async () => {
      const { router, X, Y, wallet, treasury } = await loadFixture(fixture);
      const y = await Y.getAddress();
      await expect(router.sweepTokenWithFee(y, 0, wallet.address, 0, treasury.address)).to.be.reverted;
      await expect(router.sweepTokenWithFee(y, 0, wallet.address, 101, treasury.address)).to.be.reverted;
      await expect(router.unwrapWQRL9WithFee(0, wallet.address, 101, treasury.address)).to.be.reverted;
      await expect(router.sweepTokenWithFee(y, 1, wallet.address, FEE_BIPS, treasury.address)).to.be.revertedWith('Insufficient token');
      expect(await balance(X, router)).to.equal(0n);
    });
  });

  describe('multicall', () => {
    it('chains a V2 hop into a V3 hop through the router balance', async () => {
      const { router, X, Y, Z, other } = await loadFixture(fixture);
      const [x, y, z] = [await X.getAddress(), await Y.getAddress(), await Z.getAddress()];
      const before = await balance(Z, other);
      await router.multicall(await deadline(), [
        call(router, 'swapExactTokensForTokens', [expandTo18Decimals(3), 0, [x, y], ADDRESS_THIS]),
        call(router, 'exactInputSingle', [{ tokenIn: y, tokenOut: z, fee: FEE_MEDIUM, recipient: other.address, amountIn: 0, amountOutMinimum: 1, sqrtPriceLimitX96: 0 }]),
      ]);
      expect((await balance(Z, other)) - before).to.be.greaterThan(0n);
      expect(await balance(Y, router)).to.equal(0n);
    });

    it('rejects an expired deadline and forwards inner revert reasons', async () => {
      const { router, X, Y, wallet } = await loadFixture(fixture);
      const swap = call(router, 'swapExactTokensForTokens', [expandTo18Decimals(1), MaxUint256, [await X.getAddress(), await Y.getAddress()], wallet.address]);
      await expect(router.multicall((await latestTimestamp()) - 1, [swap])).to.be.revertedWith('Transaction too old');
      await expect(router.multicall(await deadline(), [swap])).to.be.revertedWith('Too little received');
    });
  });
});
