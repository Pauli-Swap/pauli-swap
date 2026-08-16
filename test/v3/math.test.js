const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy } = require('../helpers');

// Reference values for sqrt(1.0001^tick) * 2^96, rounded up as TickMath
// specifies. Cross checked against an independent big integer computation, so
// they pin the port to the formula rather than to itself.
const TICK_TO_SQRT_RATIO = [
  [-887272n, 4295128739n],
  [-1000n, 75364347830767020784054125655n],
  [-1n, 79224201403219477170569942574n],
  [0n, 79228162514264337593543950336n],
  [1n, 79232123823359799118286999568n],
  [1000n, 83290069058676223003182343270n],
  [887272n, 1461446703485210103287273052203988822378723970342n],
];

async function fixture() {
  return { probe: await deploy('TickMathProbe') };
}

describe('V3 math libraries', () => {
  describe('TickMath', () => {
    it('matches Uniswap V3 at the tick boundaries', async () => {
      const { probe } = await loadFixture(fixture);
      expect(await probe.minTick()).to.equal(-887272n);
      expect(await probe.maxTick()).to.equal(887272n);
      expect(await probe.minSqrtRatio()).to.equal(4295128739n);
      expect(await probe.maxSqrtRatio()).to.equal(1461446703485210103287273052203988822378723970342n);
    });

    for (const [tick, expected] of TICK_TO_SQRT_RATIO) {
      it(`getSqrtRatioAtTick(${tick}) is exact`, async () => {
        const { probe } = await loadFixture(fixture);
        expect(await probe.getSqrtRatioAtTick(tick)).to.equal(expected);
      });
    }

    it('reverts outside the tick range', async () => {
      const { probe } = await loadFixture(fixture);
      await expect(probe.getSqrtRatioAtTick(-887273n)).to.be.revertedWith('T');
      await expect(probe.getSqrtRatioAtTick(887273n)).to.be.revertedWith('T');
    });

    it('round trips tick -> ratio -> tick across the range', async () => {
      const { probe } = await loadFixture(fixture);
      for (const tick of [-887272n, -500000n, -60000n, -887n, -1n, 0n, 1n, 887n, 60000n, 500000n, 887271n]) {
        const ratio = await probe.getSqrtRatioAtTick(tick);
        expect(await probe.getTickAtSqrtRatio(ratio)).to.equal(tick);
      }
    });

    it('reverts outside the sqrt ratio range', async () => {
      const { probe } = await loadFixture(fixture);
      await expect(probe.getTickAtSqrtRatio(4295128738n)).to.be.revertedWith('R');
      await expect(
        probe.getTickAtSqrtRatio(1461446703485210103287273052203988822378723970342n)
      ).to.be.revertedWith('R');
    });
  });

  describe('FullMath', () => {
    const Q128 = 2n ** 128n;
    const MAX = 2n ** 256n - 1n;

    it('computes products that overflow 256 bits without losing precision', async () => {
      const { probe } = await loadFixture(fixture);
      expect(await probe.mulDiv(Q128, Q128, Q128)).to.equal(Q128);
      expect(await probe.mulDiv(Q128, 50n * Q128, 150n * Q128)).to.equal(Q128 / 3n);
      expect(await probe.mulDiv(MAX, MAX, MAX)).to.equal(MAX);
      expect(await probe.mulDiv(1000n, 1000n, 1n)).to.equal(1000000n);
    });

    it('rounds up only when there is a remainder', async () => {
      const { probe } = await loadFixture(fixture);
      expect(await probe.mulDivRoundingUp(Q128, Q128, Q128)).to.equal(Q128);
      expect(await probe.mulDivRoundingUp(Q128, 50n * Q128, 150n * Q128)).to.equal(Q128 / 3n + 1n);
      expect(await probe.mulDivRoundingUp(1n, 1n, 3n)).to.equal(1n);
    });

    it('reverts on a zero denominator and on overflow', async () => {
      const { probe } = await loadFixture(fixture);
      await expect(probe.mulDiv(Q128, Q128, 0n)).to.be.reverted;
      await expect(probe.mulDiv(MAX, MAX, 1n)).to.be.reverted;
    });
  });

  describe('SqrtPriceMath', () => {
    it('matches Uniswap V3 amount deltas for a 1:1 range', async () => {
      const { probe } = await loadFixture(fixture);
      const p1 = await probe.getSqrtRatioAtTick(0n);
      const p2 = await probe.getSqrtRatioAtTick(60n);
      const liquidity = 10n ** 18n;

      const up = await probe.getAmount0Delta(p1, p2, liquidity, true);
      const down = await probe.getAmount0Delta(p1, p2, liquidity, false);
      expect(up).to.equal(down + 1n);

      const up1 = await probe.getAmount1Delta(p1, p2, liquidity, true);
      const down1 = await probe.getAmount1Delta(p1, p2, liquidity, false);
      expect(up1).to.be.greaterThanOrEqual(down1);
    });

    it('returns zero delta for an empty range', async () => {
      const { probe } = await loadFixture(fixture);
      const p = await probe.getSqrtRatioAtTick(0n);
      expect(await probe.getAmount0Delta(p, p, 10n ** 18n, true)).to.equal(0n);
      expect(await probe.getAmount1Delta(p, p, 10n ** 18n, true)).to.equal(0n);
    });
  });

  describe('LiquidityMath', () => {
    it('adds and subtracts signed deltas', async () => {
      const { probe } = await loadFixture(fixture);
      expect(await probe.addDelta(1n, 0n)).to.equal(1n);
      expect(await probe.addDelta(1n, -1n)).to.equal(0n);
      expect(await probe.addDelta(1n, 1n)).to.equal(2n);
    });

    it('reverts on underflow and overflow', async () => {
      const { probe } = await loadFixture(fixture);
      await expect(probe.addDelta(0n, -1n)).to.be.revertedWith('LS');
      const max = 2n ** 128n - 1n;
      await expect(probe.addDelta(max, 1n)).to.be.revertedWith('LA');
    });
  });
});
