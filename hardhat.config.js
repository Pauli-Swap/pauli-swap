require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

// Contracts are built by scripts/compile.js with @theqrl/hypc, not solc, so
// Hardhat's own compiler is pointed at an empty directory. The local network is
// used only as a QRVM compatible execution environment for the test suite.
module.exports = {
  paths: {
    sources: './contracts-solidity',
    artifacts: './artifacts',
    tests: './test',
  },
  solidity: '0.8.24',
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      hardfork: 'shanghai',
      chainId: 1337,
    },
    zondTestnet: {
      url: process.env.QRL_RPC_URL || 'https://qrlwallet.com/api/qrl-rpc/testnet',
      chainId: Number(process.env.QRL_CHAIN_ID || 1337),
      accounts: process.env.DEPLOYER_MNEMONIC ? { mnemonic: process.env.DEPLOYER_MNEMONIC } : [],
    },
  },
  mocha: {
    timeout: 120000,
  },
};
