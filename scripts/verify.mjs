import { config } from 'dotenv';
config();
import fs from 'fs';
import path from 'path';
import { Web3 } from '@theqrl/web3';

const web3 = new Web3(process.env.QRL_RPC_URL);
const ART = path.resolve('build/hyperion');
const idx = JSON.parse(fs.readFileSync(path.join(ART, 'index.json'), 'utf8'));
const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(ART, idx[n][0], `${n}.json`), 'utf8'));

const d = JSON.parse(fs.readFileSync('deployments/zondTestnet.json', 'utf8'));

const factory = new web3.qrl.Contract(abiOf('HyperionV2Factory').abi, d.v2.factory);
const router = new web3.qrl.Contract(abiOf('HyperionV2Router02').abi, d.v2.router02);

console.log('--- on chain state ---');
console.log('factory.feeToSetter   ', await factory.methods.feeToSetter().call());
console.log('factory.feeTo         ', await factory.methods.feeTo().call());
console.log('factory.allPairsLength', (await factory.methods.allPairsLength().call()).toString());

const onChainHash = await factory.methods.pairCodeHash().call();
const artifactHash = web3.utils.keccak256(abiOf('HyperionV2Pair').bytecode);
console.log('factory.pairCodeHash  ', onChainHash);
console.log('artifact pair hash    ', artifactHash);
console.log('  match               ', onChainHash.toLowerCase() === artifactHash.toLowerCase() ? 'YES' : 'NO');

console.log('\nrouter.factory        ', await router.methods.factory().call());
console.log('  points at factory   ', (await router.methods.factory().call()).toLowerCase() === d.v2.factory.toLowerCase() ? 'YES' : 'NO');
console.log('router.WQRL           ', await router.methods.WQRL().call());
console.log('  points at WQRL      ', (await router.methods.WQRL().call()).toLowerCase() === d.wqrl.toLowerCase() ? 'YES' : 'NO');

console.log('\n--- pure library maths through the deployed router ---');
console.log('quote(1e18, 5e18, 10e18)      ', (await router.methods.quote(10n ** 18n, 5n * 10n ** 18n, 10n * 10n ** 18n).call()).toString());
console.log('getAmountOut(1e18,5e18,10e18) ', (await router.methods.getAmountOut(10n ** 18n, 5n * 10n ** 18n, 10n * 10n ** 18n).call()).toString());
console.log('  expected (Uniswap V2)        1662497915624478906');
console.log('getAmountIn(1e18,5e18,10e18)  ', (await router.methods.getAmountIn(10n ** 18n, 5n * 10n ** 18n, 10n * 10n ** 18n).call()).toString());

console.log('\n--- WQRL reachable from the router wiring ---');
const wqrlAbi = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];
const wqrl = new web3.qrl.Contract(wqrlAbi, d.wqrl);
console.log('WQRL.name             ', await wqrl.methods.name().call());
console.log('WQRL.symbol           ', await wqrl.methods.symbol().call());
console.log('WQRL.totalSupply      ', (await wqrl.methods.totalSupply().call()).toString());

