const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploy, artifactOf } = require('../helpers');

const TOKEN_A = '0x1000000000000000000000000000000000000000';
const TOKEN_B = '0x2000000000000000000000000000000000000000';

async function fixture() {
  const [wallet, other] = await ethers.getSigners();
  const factory = await deploy('HyperionV2Factory', [wallet.address], wallet);
  return { factory, wallet, other };
}

describe('HyperionV2Factory', () => {
  it('starts with no pairs and the configured feeToSetter', async () => {
    const { factory, wallet } = await loadFixture(fixture);
    expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
    expect(await factory.feeToSetter()).to.equal(wallet.address);
    expect(await factory.allPairsLength()).to.equal(0n);
  });

  it('creates a pair at the CREATE2 address and registers it both ways', async () => {
    const { factory } = await loadFixture(fixture);
    const [token0, token1] = TOKEN_A < TOKEN_B ? [TOKEN_A, TOKEN_B] : [TOKEN_B, TOKEN_A];

    const initCodeHash = ethers.keccak256(artifactOf('HyperionV2Pair').bytecode);
    const expected = ethers.getCreate2Address(
      await factory.getAddress(),
      ethers.keccak256(ethers.solidityPacked(['address', 'address'], [token0, token1])),
      initCodeHash
    );

    await expect(factory.createPair(TOKEN_A, TOKEN_B))
      .to.emit(factory, 'PairCreated')
      .withArgs(token0, token1, expected, 1n);

    expect(await factory.getPair(TOKEN_A, TOKEN_B)).to.equal(expected);
    expect(await factory.getPair(TOKEN_B, TOKEN_A)).to.equal(expected);
    expect(await factory.allPairs(0)).to.equal(expected);
    expect(await factory.allPairsLength()).to.equal(1n);
  });

  it('exposes a pairCodeHash matching the compiled pair', async () => {
    const { factory } = await loadFixture(fixture);
    expect(await factory.pairCodeHash()).to.equal(
      ethers.keccak256(artifactOf('HyperionV2Pair').bytecode)
    );
  });

  it('initialises the pair with sorted tokens and the factory', async () => {
    const { factory } = await loadFixture(fixture);
    await factory.createPair(TOKEN_A, TOKEN_B);
    const pair = await ethers.getContractAt(
      artifactOf('HyperionV2Pair').abi,
      await factory.getPair(TOKEN_A, TOKEN_B)
    );
    const [token0, token1] = TOKEN_A < TOKEN_B ? [TOKEN_A, TOKEN_B] : [TOKEN_B, TOKEN_A];
    expect(await pair.factory()).to.equal(await factory.getAddress());
    expect(await pair.token0()).to.equal(token0);
    expect(await pair.token1()).to.equal(token1);
  });

  it('rejects duplicate, identical and zero token pairs', async () => {
    const { factory } = await loadFixture(fixture);
    await factory.createPair(TOKEN_A, TOKEN_B);
    await expect(factory.createPair(TOKEN_A, TOKEN_B)).to.be.revertedWith('HyperionV2: PAIR_EXISTS');
    await expect(factory.createPair(TOKEN_B, TOKEN_A)).to.be.revertedWith('HyperionV2: PAIR_EXISTS');
    await expect(factory.createPair(TOKEN_A, TOKEN_A)).to.be.revertedWith('HyperionV2: IDENTICAL_ADDRESSES');
    await expect(factory.createPair(ethers.ZeroAddress, TOKEN_A)).to.be.revertedWith('HyperionV2: ZERO_ADDRESS');
  });

  it('gates feeTo and feeToSetter on the current setter', async () => {
    const { factory, wallet, other } = await loadFixture(fixture);
    await expect(factory.connect(other).setFeeTo(other.address)).to.be.revertedWith('HyperionV2: FORBIDDEN');
    await expect(factory.connect(other).setFeeToSetter(other.address)).to.be.revertedWith('HyperionV2: FORBIDDEN');

    await factory.setFeeTo(wallet.address);
    expect(await factory.feeTo()).to.equal(wallet.address);

    await factory.setFeeToSetter(other.address);
    expect(await factory.feeToSetter()).to.equal(other.address);
    await expect(factory.setFeeTo(wallet.address)).to.be.revertedWith('HyperionV2: FORBIDDEN');
  });
});
