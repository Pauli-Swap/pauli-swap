require('dotenv').config();
const { MLDSA87 } = require('@theqrl/wallet.js');

/// Derives the Zond deploying account from a QRL mnemonic.
///
/// Zond transactions are ML-DSA-87 signed and carry a signature blob plus a
/// public key rather than ECDSA r/s/v, so ethers cannot produce one at all: it
/// signs secp256k1 and rejects QRL's 34 word mnemonic outright. Every signing
/// path therefore goes through the QRL libraries, never through Hardhat.
///
/// `web3` must be a Web3 instance: the standalone `seedToAccount` export returns
/// an account whose signTransaction is a stub that throws, because signing needs
/// the chain context. Only the context bound `web3.qrl.accounts.seedToAccount`
/// produces a usable account.
function accountFromMnemonic(web3, mnemonic) {
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC is not set in .env');

  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 34) {
    throw new Error(`Expected a 34 word QRL mnemonic, got ${words.length} words.`);
  }

  const wallet = MLDSA87.newWalletFromMnemonic(words.join(' '));
  const seed = wallet.getHexExtendedSeed();
  const account = web3.qrl.accounts.seedToAccount(seed);

  const size = (account.address.length - 1) / 2;
  if (size !== 20) {
    throw new Error(
      `Derived a ${size} byte address. This project targets the 20 byte generation ` +
        'of the QRL stack, which hypc 0.0.2 compiles for. Pin @theqrl/web3 to 1.0.1; ' +
        'from 1.0.2 onwards it depends on wallet.js 6.x, which derives 64 byte addresses.'
    );
  }

  return { seed, account, address: account.address };
}

module.exports = { accountFromMnemonic };

if (require.main === module) {
  const { Web3 } = require('@theqrl/web3');
  const web3 = new Web3(process.env.QRL_RPC_URL);
  console.log(accountFromMnemonic(web3, process.env.DEPLOYER_MNEMONIC).address);
}
