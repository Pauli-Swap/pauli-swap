# PauliSwap

Uniswap V2 and V3 ported to [Hyperion](https://github.com/theQRL/hyperion), the
QRL fork of Solidity, targeting the **QRL Zond testnet v2** (`chainId` 1337).

Two independent AMMs:

- **Pauli V2** — constant product pairs, `PauliV2Factory` +
  `PauliV2Router02`. **Deployed to testnet.**
- **Pauli V3** — concentrated liquidity, `PauliV3Factory` + `SwapRouter` +
  `Quoter`, with positions held as NFTs by `NonfungiblePositionManager`, plus
  `TickLens` and `V3Migrator` (V2 to V3). Built and tested, **not deployed**:
  the wallet RPC proxy caps request bodies below the size of the V3 factory
  deployment. Waiting on an endpoint without that cap; see
  [Testnet addresses](#testnet-addresses).

Read [`docs/AUDIT.md`](docs/AUDIT.md) before using any of this. It records what
had to change for Zond, what was found and fixed, what is verified, and what is
not.

A second build line targets QIP-55 networks (64 byte addresses, 512 bit QRVM
words), such as the private devnet on `quantum-ark`. It compiles the same
sources with a handful of files replaced from `contracts-qrvm/`; see
[`docs/QRVM.md`](docs/QRVM.md) for every replacement and why, and
[`docs/ONCHAIN-AUDIT.md`](docs/ONCHAIN-AUDIT.md) for the devnet audit.

## The three differences that matter

1. **No `ecrecover` on Zond.** Accounts are ML-DSA-87, so there is no secp256k1
   recovery precompile and the compiler has no `ecrecover` builtin. Every
   EIP-2612 `permit` path is gone — callers must `approve` first.
2. **Addresses have three spellings** for the same 20 bytes: `Q` on the network,
   `0x` in the EVM test rig, `Z` with a checksum in Hyperion source literals.
3. **Hyperion checks arithmetic by default.** Uniswap relies on silent wrapping
   in its oracle, fee accumulators and 512-bit math, so those sites are
   explicitly `unchecked`.

## Layout

```
contracts/
  v2/core/          PauliV2Factory, PauliV2Pair, PauliV2SQRCTF1
  v2/periphery/     PauliV2Router02, PauliV2Library, TransferHelper
  v3/core/          PauliV3Factory, PauliV3Pool, math libraries
  v3/periphery/     SwapRouter, Quoter, NonfungiblePositionManager,
                    PauliV3PositionDescriptor, TickLens, V3Migrator
  vendor/           SQRCTN1Enumerable, from qrl-contracts main (not on npm)
  tokens/           WQRL
  test/             fixtures and library probes, not for deployment
scripts/
  compile.js        hypc driver, writes build/hyperion/
  init-code-hash.js regenerates the pinned CREATE2 init code hashes
  deploy.js         deploys against a configured network
docs/AUDIT.md       port review
```

`CLAUDE.md` holds the coding rules this repository is written to.

## Build and test

```
npm install
npm run build     # compile -> regenerate init code hashes -> compile
npm test          # 122 tests
```

`npm run build` compiles twice on purpose. The routers hardcode the `CREATE2`
init code hash of the pair and the pool, so the hash has to be generated from a
first build and then baked into a second. `scripts/compile.js` fails the build if
any contract exceeds Zond's 24576 byte code limit — V3 sits close to it, see
§1.4 of the audit.

Tests run the `hypc` output on a local EVM. That is valid because the bytecode
Hyperion emits is standard 256-bit EVM; it is not a substitute for running
against a Zond node.

## Testnet addresses

Every deployment listed here predates the 2026-10-28 rename from `AcornV2*` /
`AcornV3*` to `PauliV2*` / `PauliV3*`. The deployed bytecode still carries the
old revert strings (`AcornV2: K`) and callback names (`acornV3SwapCallback`),
and the init code hashes below are those of the old build.

<!-- deployments:start -->

**zondTestnet** (chainId 1337), addresses in `Q` form:

| Contract | Address |
| --- | --- |
| WQRL (pre-existing) | `Q823b2FAeEbC9e1EE8e20454201502ef0679cC4AE` |
| PauliV2Factory | `QA19FA6B49A10F1B57E303ECE95eF21acE640d312` |
| PauliV2Router02 | `QE89663F7f2a4955A82a2852D1624f51569080916` |

- V2 pair init code hash: `0x5fb17eaa6a423644c910c64d7a3c99f47cd34f3c167089b5b8016358ee99c484`

> **V3 is not deployed.** `PauliV3Factory` has 24,498 bytes of init code even at
> `runs: 1`, because it embeds the pool's init code. The wallet RPC proxy
> (`qrlwallet.com/api/qrl-rpc/testnet`) caps a request body at ~51 KB, and an
> ML-DSA-87 signature plus public key already costs ~7.3 KB of that, leaving room
> for roughly 18 KB of init code. Nothing in the contracts or the build is
> blocking this.
>
> Waiting on an RPC endpoint without that body cap. Once one is available, point
> `QRL_RPC_URL` at it and run `npm run deploy:v3` — no code change needed.

<!-- deployments:end -->

Addresses are written by `scripts/deploy.js` into `deployments/<network>.json`
and rendered here by `npm run addresses`. The deploy script runs that step
itself, so this section never has to be edited by hand.

**Superseded — do not use.** An earlier deployment carried the working name
Hyperion Swap. Renaming to PauliSwap changed the contract names, the revert
strings and the LP token symbol, all of which live in the pair's bytecode, so
`PAIR_INIT_CODE_HASH` changed and the old factory could no longer be addressed
by the new router. It held no pairs and no liquidity when it was replaced.

| Contract | Address |
| --- | --- |
| `HyperionV2Factory` | `Q2755080D68dc856942AA54bCE11fC2e5fE329263` |
| `HyperionV2Router02` | `Q0c62B46e3C36C0982eE0343FFB91471E10fd63E3` |

## Deploying

Copy `.env.example` to `.env` and fill it in:

```
QRL_RPC_URL="https://qrlwallet.com/api/qrl-rpc/testnet"
QRL_CHAIN_ID=1337
DEPLOYER_MNEMONIC="..."
WQRL_ADDRESS="Q823b2FAeEbC9e1EE8e20454201502ef0679cC4AE"
```

`WQRL_ADDRESS` is required. Several WQRL contracts already exist on the testnet,
so the deploy script wires the routers to the one you name and refuses to
publish another. It verifies there is code at that address before continuing.

```
npm run deploy          # V2 and V3
npm run deploy:v2
npm run deploy:v3
```

### Deployment does not go through Hardhat

Hardhat and ethers are the **test** rig only. They cannot deploy to Zond, for
reasons that are structural rather than configuration:

- Zond transactions are **ML-DSA-87** signed. `go-zond` carries a signature blob
  plus a separate public key and descriptor, not ECDSA `r`/`s`/`v`, and derives
  the sender from the public key instead of recovering it. ethers signs
  secp256k1, so it cannot produce a valid transaction at all.
- Only transaction type `0x02` exists on Zond.
- QRL mnemonics are **34 words**. ethers rejects the phrase outright with
  `invalid mnemonic length`, since BIP-39 allows 12/15/18/21/24.

`scripts/deploy.js` therefore runs on `@theqrl/web3` and derives the account
with `@theqrl/wallet.js` (`scripts/account.js`). Run `npm run account` to print
the deploying address.

### Pin the 20 byte generation of the QRL stack

The QRL libraries changed address width mid-2026 and the released compiler did
not follow. Verified by deriving the same mnemonic across versions:

| Package | 20 byte addresses | 64 byte addresses |
| --- | --- | --- |
| `@theqrl/wallet.js` | ≤ 5.1.0 | ≥ 6.0.0 (2026-05-20) |
| `@theqrl/web3` | ≤ 1.0.1 | ≥ 1.0.2 (2026-07-16) |
| `@theqrl/hypc` | 0.0.2, the only release (2025-02-21) | none |

`hypc` compiles for 20 byte addresses, and the WQRL contract this project reuses
is a 20 byte address, so `@theqrl/web3` is pinned to **exactly `1.0.1`**. Do not
let it float: on 1.0.2+ the same mnemonic derives a 64 byte address and the
deployer would not be the funded account. `scripts/account.js` checks the width
and fails loudly if the pin is lost.

The 64 byte generation is served by the separate QRVM line, built with a
`hypc` compiled from hyperion `main` and deployed with `@theqrl/web3` 1.0.3
under an npm alias, so this pin is unaffected. See [`docs/QRVM.md`](docs/QRVM.md).

### The JSON-RPC namespace is `qrl_`, not `zond_`

The node implementation is called go-zond, but its JSON-RPC methods are
namespaced `qrl_`. `zond_*` returns `-32601 Method not allowed`, which reads like
an access restriction and is easy to misdiagnose as a locked down endpoint.

```
qrl_blockNumber          200 {"result":"0x305b2"}
qrl_chainId              200 {"result":"0x539"}
qrl_sendRawTransaction   200 {"error":{"code":-32000,"message":"typed transaction too short"}}
zond_blockNumber         403 {"error":{"code":-32601,"message":"Method not allowed"}}
```

### The wallet RPC caps request bodies at ~51 KB

`qrlwallet.com/api/qrl-rpc/testnet` works for deployment, but rejects bodies over
roughly 51,180 bytes with `Request body too large`. Because an ML-DSA-87
signature plus public key costs about 7.3 KB inside every transaction, the
deployable init code through this endpoint is about **18 KB**:

| Contract | init code | fits |
| --- | --- | --- |
| `PauliV2Factory` | 12,442 | yes |
| `PauliV2Router02` (200 runs) | 15,328 | yes |
| `SwapRouter` | 8,174 | yes |
| `Quoter` | 4,181 | yes |
| `NonfungiblePositionManager` | 18,493 | **no**, about 250 bytes over |
| `PauliV3Factory` | 24,498 even at `runs: 1` | **no** |

`PauliV3Factory` embeds the pool's init code, so no optimizer setting brings
it under the cap. Deploying V3 needs either a `gqrl` node you control (no proxy,
no body cap) or splitting the pool deployer out of the factory — which would
change what `PoolAddress.computeAddress` derives from and is a real design
change, not a build flag.

This is also why V2 core and V2 periphery compile at different run counts: the
core's run count is frozen into `PAIR_INIT_CODE_HASH`, so only the periphery
could be shrunk to fit.

Note also that a 20 byte Zond address has three spellings: `Q` + 40 hex on the
network, in the wallet and in the QRL libraries; `0x` in ethers and inside the
EVM based test rig; and `Z` + 40 hex with a mixed case checksum in Hyperion
source literals. `hypc` 0.0.2 rejects `Q` prefixed literals. The deploy script
normalises to `Q`.

## QRVM line (QIP-55)

```
npm run compile:qrvm      # hypc:local -> build/qrvm/, contracts-qrvm/ overlaid
npm run check:qrvm        # ABI parity with the 20 byte build, OC-V3-02 lint
QRVM_ENV=.env.devnet npm run deploy:qrvm
QRVM_ENV=.env.devnet npm run audit:qrvm   # scenario on QRVM and on the EVM build, compared
QRVM_ENV=.env.devnet npm run diff:qrvm    # math library differential vectors
```

Devnet addresses are not listed here: that chain regenerates from genesis
whenever its host restarts. The audited deployment, with every address and
transaction, is embedded in `docs/onchain/devnet.json`.

## Toolchain

| | |
| --- | --- |
| Compiler | `@theqrl/hypc` 0.0.2 |
| Standard library | `@theqrl/qrl-contracts` 0.1.0; the QRVM line uses its `main` at `d3c84ee` (npm alias `qrl-contracts-qip55`) |
| Node | `theQRL/go-zond` |
| Upstream | `Uniswap/v2-core`, `Uniswap/v2-periphery`, `Uniswap/v3-core` v1.0.0, `Uniswap/v3-periphery` v1.3.0 |

Token standard names follow QRL's: **SQRC-TF1** is the fungible token standard
(ERC-20's counterpart), which is why the V2 liquidity token is
`PauliV2SQRCTF1`. The ABI is unchanged — `transfer`, `approve`,
`transferFrom`, `balanceOf`, `allowance`, plus `Transfer` and `Approval`.
