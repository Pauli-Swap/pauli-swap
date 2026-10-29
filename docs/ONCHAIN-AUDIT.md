# PauliSwap V2 + V3 — on-chain audit on the private QIP-55 devnet

**Result: no mismatches and no failed checks.** On the devnet, the QRVM build of
PauliSwap V2 and V3, including the position NFT manager, matched the 20-byte
reference build on 105 out of 105 compared values, passed 68 out of 68 on-chain
invariant checks, and agreed on 1,128 out of 1,128 math-library vectors.

How the port was done is in [`QRVM.md`](QRVM.md). This document covers the run
on the real chain. Raw data:
[`onchain/devnet.json`](onchain/devnet.json) (scenario, deployment, every
transaction) and
[`onchain/devnet.differential.json`](onchain/devnet.differential.json)
(vectors).

## Rerun on 2026-10-29: the current build and SwapRouter02

**Result: no mismatches and no failed checks.** The run below this section
audited the build from before the 2026-10-28 rename and devnet reset, whose
bytecode differs from what is live now (pair and pool code hashes changed). It
was rerun against the current build, with `SwapRouter02` (QRVM.md Q8) added
to the scenario:

| Run | Result | Data |
| --- | --- | --- |
| Full scenario on a twin deployment of the current build (blocks 2697–2713, scenario 2715–2831) | 121/121 values identical to the 20 byte build, 85/85 checks | [`onchain/devnet-audit.json`](onchain/devnet-audit.json) |
| Math vectors | 1,128/1,128 | [`onchain/devnet.differential.json`](onchain/devnet.differential.json) |
| Live deployment: runtime code of every contract, `SwapRouter02` included, against `build/qrvm` (immutables and library links masked) | 17/17 checks | [`onchain/devnet.code.json`](onchain/devnet.code.json) |

Why a twin: the scenario creates its own tokens and about eight V2 and V3
pools on the factories it audits. On the live factories those would show in
the interface and the indexer, and decide PauliSwap Predict market #2 ("at
least 10 pools by Nov 5") by the owner's own hand. The twin is deployed from
the same artifacts, and the live code check shows the live contracts are those
artifacts, so the scenario's results carry over. `AUDIT_CODE_ONLY=1` runs that
check alone.

`SwapRouter02` was added to the live deployment in block 2876
(`QRVM_ADD=SwapRouter02 npm run deploy:qrvm`), wired to the existing
factories and WQRL; nothing else was redeployed. Its part of the scenario, all
matching the 20 byte build:

- V2 exact input and exact output equal `PauliV2Router02.getAmountsOut` /
  `getAmountsIn`; a fee-on-transfer input is measured, not trusted.
- V3 `exactInputSingle` and two-hop `exactOutput` equal the `Quoter`.
- Swap to the router plus `sweepTokenWithFee` at 25 bips pays exactly
  `gross × 25 / 10000` to the fee recipient and the rest to the wallet; the
  same with `unwrapWQRL9WithFee` in QRL. The router keeps nothing.
- A V2 hop into a V3 hop through the router balance (`ADDRESS_THIS`, then
  `amountIn` 0).
- An expired deadline reverts with `Transaction too old`; `multicall` forwards
  `Too little received` (the QRVM overlay's 132 byte bound); a fee of 0 or 101
  bips and a short sweep revert.

| Operation | QRVM | EVM |
| --- | ---: | ---: |
| `SwapRouter02` V2 `swapExactTokensForTokens` | 131,273 | 135,366 |
| `SwapRouter02` V3 `exactInputSingle` | 150,384 | 116,957 |
| `SwapRouter02` V3 two-hop `exactOutput` | 246,330 | 187,518 |
| `multicall` swap + `sweepTokenWithFee` | 201,259 | 156,038 |
| `multicall` swap + `unwrapWQRL9WithFee` | 204,374 | 166,633 |
| `multicall` V2 then V3 | 231,566 | 199,940 |

The rest of this document is the first run, kept as it was.

## Environment

| | |
| --- | --- |
| Network | private devnet on `quantum-ark` (Kurtosis: 2 gqrl, 2 qrysm beacon, 2 validators, 12 s slots) |
| Chain id | 3151908 (QIP-55: 64-byte addresses, 512-bit QRVM) |
| Genesis | 2026-10-27 02:03:29 UTC |
| Node | gqrl 0.3.3, go-zond `b92884a3` |
| Compiler | hyperion `main` `f570687a` (0.2.0-develop), legacy codegen; V3 at 1 optimizer run |
| Access | SSH tunnel to the node's RPC on `127.0.0.1:8545`. The public `/rpc/private-testnet` filter was not used. |
| Deployer | `Qa1A64D6…2a9234Ca`, a key dedicated to PauliSwap, funded with 100 QRL from the devnet faucet |
| Deployment | blocks 1577–1591 (2026-10-27 08:08 UTC) |
| Scenario | blocks 1859–1960, finished 09:33 UTC |
| Differential | after block 1960 (eth_call only, plus two probe deployments) |

The devnet regenerates from genesis every time its host restarts, and the host
stops at 02:00 Vietnam time every day. The addresses below are therefore a
record of this run, not a standing deployment. To audit again after a restart,
redeploy first; see "Reproduce" at the end.

The devnet's default deployer key was **not** used. The Ark Staking relayer
signs with that key continuously: it sent 141 transactions in the first 40
minutes after genesis. A second writer on the same nonce sequence would replace
or block the relayer's transactions. The only transaction this audit sent from
that key was one WQRL deployment, at `Q3Cc75028…9a1B71`, before the conflict
was found. That WQRL is unused. The next transaction was rejected by the node
and did not replace anything.

The PauliSwap key itself must also have a single writer. Three earlier
attempts at this run failed with `replacement transaction underpriced` because
a devnet seeding script in the `pauli-swap-interface` workspace was signing
with the same key at the same time. The run recorded here started after that
script had finished, with no other sender on the key.

## Deployment audited

The audit ran before the contracts were renamed from `AcornV2*` / `AcornV3*` to
`PauliV2*` / `PauliV3*` (2026-10-28). The names below are the current ones; the
bytecode on chain, the raw data under `onchain/` and the revert strings quoted
in this document come from the old build, where every `Pauli` read `Acorn`.

| Contract | Address |
| --- | --- |
| WQRL (new; the chain has none) | `Q8Ff9690B216…0BcAaC` |
| PauliV2Factory | `Q710abD658c7…9aA2fE` |
| PauliV2Router02 | `Q504690136d0…7217f9` |
| Oracle (linked library) | `QE3bA8a51C2a…0298DB` |
| Pool code chunk A / B | `Q0eD673bFB78…D30Ad3` / `Q2Ed1DCAC5f7…eD5ddA` |
| PauliV3Factory | `Q40Df6271761…42Eec2` |
| SwapRouter | `Q22818bB9899…895641` |
| Quoter | `Qa6736BF85B6…02B006` |
| PauliV3PoolLens | `Q79E8861B0D0…780DF4` |
| PauliV3PositionDescriptor | `Q00acD7c8D65…e0E46E` |
| NonfungiblePositionManager | `Q659889778c4…39a6Af` |
| TickLens | `Q5Fb25E00400…C43051` |
| V3Migrator | `Q99394CB95b7…d4Dd45` |

An earlier deployment from the same day (`PauliV3Factory` `Q5DB0b76737a…ED92B1`),
without the position contracts, was audited first with the same result on its
73 values and 44 checks. It is superseded by the one above.

Full 64-byte addresses are in `onchain/devnet.json` under `deployment.contracts`.

Code hashes used for off-chain address derivation:

- `pairCodeHash` = `0x158ab696…ad823cf`
- `poolCodeHash` = `0x3ba421e7…52fd1e3`

The pool code hash differs from the earlier deployment because the pool's init
code links the address of the `Oracle` library, and `Oracle` was redeployed.

## Method

1. **Bytecode provenance.** Each deployed contract's runtime code is compared
   with `build/qrvm` byte for byte. The only bytes allowed to differ are
   immutables and library links. For `Oracle`, the library call-protection
   slot (its first 64 bytes after the opcode) must contain the library's own
   address. The two pool code chunks were checked byte for byte at deploy
   time. On chain, `factory.poolCodeHash()` must equal the keccak256 of the
   locally linked pool init code.
2. **Differential scenario.** `scripts/qrvm/audit.js` runs one scenario twice:
   - against the devnet deployment;
   - against the unchanged 20-byte build on Hardhat's EVM, which the 122-test
     suite already holds to Uniswap's behaviour.

   Test tokens are sorted into roles X < Y < Z on each chain, so amounts,
   reserves, LP supply, ticks, fee growth, positions and revert reasons are
   compared one to one. Values that depend on addresses or on the clock are
   checked as invariants instead.
3. **Math vectors.** `scripts/qrvm/differential.js` sends the same 1,128 inputs
   through `TickMathProbe` and `PauliV2LibraryProbe` on both builds. The inputs
   are extreme ticks and prices, mulDiv overflow edges, and wide random
   operands from a seeded generator. An outcome is either a value or a revert
   reason, and the two builds must agree exactly.

## Results

### V2

All of the following matched the reference.

**Liquidity and swaps**

- `addLiquidity` 10/40 minted 19.999…999000 LP; MINIMUM_LIQUIDITY of 1000 went
  to the zero address.
- `getAmountsOut` and `swapExactTokensForTokens` both returned
  3.626443575520596526 for 1e18 in.
- `swapTokensForExactTokens` required 3.648300544080180891 in for 1e18 out.
- A two-hop X→Y→Z swap matched.
- Native QRL through WQRL matched: `addLiquidityQRL`,
  `swapExactQRLForTokens` (1662497915624478906 out, bit identical to the value
  recorded on testnet v2), `swapExactTokensForQRL` and `removeLiquidityQRL`.
- Fee-on-transfer token: both `…SupportingFeeOnTransferTokens` swaps and
  `removeLiquidityQRLSupportingFeeOnTransferTokens` matched.

**Flash swaps, reentrancy, protocol fee**

- A correctly repaid flash swap succeeds.
- An underpaid flash swap reverts with `PauliV2: K`.
- A reentrant `sync` from the callback reverts with `PauliV2: LOCKED`.
- With the protocol fee switched on, the fee LP minted to `feeTo` and the
  resulting `kLast` matched.

**Reverts and getters**

- These revert reasons matched: `PauliV2Router: EXPIRED`,
  `INSUFFICIENT_OUTPUT_AMOUNT`, `PauliV2: IDENTICAL_ADDRESSES` and
  `PAIR_EXISTS`.
- The explicit `balanceOf`, `allowance` and `getPair` views returned correct
  values (OC-V3-02 regression check).
- Pair address: the on-chain `getPair` result equals the off-chain QIP-55
  CREATE2 formula, and `pairCodeHash` equals the local artifact.

### V3

All of the following matched the reference.

**Pool creation**

- `getPool` is symmetric, and the pool address equals the off-chain formula
  over the split-code `poolCodeHash`.
- Immutables: fee 3000, spacing 60, maxLiquidityPerTick
  11505743598341114571880798222544994.
- `initialize` at tick 198; a second `initialize` reverts with `AI`.

**Liquidity and pool state**

- Narrow and full-range mints matched.
- Explicit views returned correct data: `ticks(-600)`, `tickBitmap(-1)`,
  `tickBitmap(0)`, `positions(key)` (OC-V3-02 regression check).
- A mint with `tickLower ≥ tickUpper` reverts with `TLU`.

**Swaps and quotes**

- `exactInputSingle` returned 10.077155491989975865 and the Quoter gave the
  same value.
- `exactOutputSingle`, two-hop `exactInput` and two-hop `exactOutput` all
  matched, and each equals its Quoter result. This exercises `Path` and
  `BytesLib` with 64-byte addresses.
- Native QRL in, and a `multicall` of swap + `unwrapWQRL9` paying native QRL
  out, both work. The routers held no residual QRL or WQRL afterwards.
- `multicall` passes the inner revert reason through (`Insufficient WQRL9`).

**Flash, fees, burn and collect**

- Flash: fee growth matched; over-borrowing reverts with `TF`.
- Protocol fee 1/4: `protocolFees` and `collectProtocol` matched.
- `burn`, the position after the burn, and `collect` matched.

**Reverts, oracle and lens**

- `AS`, `SPL` and an invalid `setFeeProtocol` revert the same way.
- `increaseObservationCardinalityNext` through the linked `Oracle` set
  cardinalityNext to 10.
- `observe` answers; a too-old observation reverts with `OLD`.
- `snapshotCumulativesInside` via the lens answers, and on uninitialized ticks
  it reverts like upstream.
- `noDelegateCall` blocks a delegated swap.
- Calling a pool code chunk does nothing.
- Calling `Oracle` directly is rejected.

### Position NFTs

All of the following matched the reference, value for value.

**Pool creation and minting**

- `createAndInitializePoolIfNecessary` creates and initializes a new X/Z 0.05%
  pool at tick 198. A second call with a different price leaves it unchanged.
  Called with unsorted tokens, it reverts.
- `mint` over −1000..1000 with 5e18 of each token returned liquidity
  85151761377825512730, taking 3313743853832194123 X and 5e18 Z.
- The manager's own position in the pool holds exactly that liquidity, and
  `ownerOf`, `totalSupply` and `tokenOfOwnerByIndex` see the new token.
- `positions()` matched: tokens X/Z, fee, ticks, liquidity, fee growth and
  owed amounts, with `nonce` 0 and no operator.

**Fees and liquidity changes**

- After two swaps through the router, `increaseLiquidity` folded the accrued
  fees into `tokensOwed`, and `collect` paid out 499999999999999 X and
  1000000000000000 Z.
- `decreaseLiquidity` of half, then a full decrease, `collect` and `burn`,
  all matched.
- Reverts matched: `Price slippage check`, `Not cleared` and, after the burn,
  `Invalid token ID`.

**Authorization and transfers**

- `approve` is reflected in `positions().operator`, and a transfer clears it.
- A `safeTransferFrom` to a contract that accepts moves the token.
- The new owner's position cannot be decreased by the old owner (`Not
  approved`), including through `multicall`.
- A non-owner `transferFrom` reverts with the same SQRC-TN1 custom error
  selector on both chains.
- A forged mint callback is rejected.

**Lens, metadata, native QRL, migration**

- `TickLens` returned the same populated ticks as the reference.
- The `tokenURI` name is identical:
  `Pauli - 0.05% - PAULI-V2/PAULI-V2 - -1000<>1000`.
- The `tokenURI` description carries the pool's 128-hex-digit address.
- A `multicall` of a native QRL mint plus `refundQRL` wrapped the QRL into the
  pool and left the manager holding none. The WQRL amount differs by 1 wei
  between the chains because WQRL sorts as token0 on one chain and token1 on
  the other, so it is not compared.
- `V3Migrator` moved half of a V2 Y/Z position into V3. The values matched:
  no V2 LP left, the same refunds, the same V3 liquidity, and the manager's
  allowances reset to 0.

**One behaviour that differs, in the library.** A receiver contract that
rejects a `safeTransferFrom` with the reason `"Receiver rejects"` produces that
reason on the EVM. On QRVM the revert arrives as 4 zero bytes. The transfer
still reverts and ownership is unchanged; only the reason is lost. The cause is
in qrl-contracts `main`, not PauliSwap: `SQRCTN1Utils` re-raises the
receiver's revert with a 32-byte offset (see `QRVM.md` Q7).

### Math vectors

| Function | Vectors | Of which revert | Mismatched |
| --- | ---: | ---: | ---: |
| `getSqrtRatioAtTick` | 159 | 2 | 0 |
| `getTickAtSqrtRatio` | 156 | 2 | 0 |
| `mulDiv` | 163 | 33 | 0 |
| `mulDivRoundingUp` | 163 | 33 | 0 |
| `getAmount0Delta` / `getAmount1Delta` | 240 | 0 | 0 |
| `addDelta` | 5 | 3 | 0 |
| V2 `getAmountOut` / `getAmountIn` | 242 | 32 | 0 |

### Gas, QRVM vs the 20-byte EVM build

| Operation | QRVM | EVM |
| --- | ---: | ---: |
| V2 `addLiquidity` creating a pair | 3,554,190 | 2,423,535 |
| V2 `swapExactTokensForTokens` | 132,311 | 134,586 |
| V2 two-hop swap | 195,070 | 191,028 |
| V2 flash swap | 117,166 | 113,704 |
| V3 `createPool` | 4,890,569 | 4,518,968 |
| V3 `mint`, new ticks | 341,102 | 329,436 |
| V3 `exactInputSingle` | 161,004 | 126,903 |
| V3 two-hop `exactInput` | 276,040 | 212,297 |
| V3 `flash` | 146,972 | 128,800 |
| V3 `collect` | 79,582 | 64,094 |
| NPM `createAndInitializePoolIfNecessary` | 4,950,084 | 4,573,793 |
| NPM `mint`, new position | 618,508 | 566,521 |
| NPM `increaseLiquidity` | 232,729 | 284,960 |
| NPM `decreaseLiquidity` | 125,037 | 154,381 |
| NPM `collect` | 135,569 | 114,991 |
| NPM `burn` | 64,268 | 68,520 |
| NPM `multicall` mint with QRL + refund | 530,448 | 538,595 |
| `V3Migrator.migrate` | 578,934 | 544,978 |

V2 is close to parity except for pair creation, where the pair's QRVM code is
larger. V3 swaps cost 25–30% more, which matches what the port design predicts
(Q1 and Q5 in `QRVM.md`): delegatecalls into the linked `Oracle`, the factory
lookup in the router, and 64-byte words.

## Findings from the port

These were found while porting and are fixed in the QRVM line. They describe
what a direct recompile of the 20-byte sources would do on QRVM, not defects of
the deployed testnet V2.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| Q3 | High | Upstream `FullMath.mulDiv` silently truncates on QRVM instead of reverting (`mulDiv(MAX, MAX, MAX-1)` returns 0). Every swap, mint and burn uses it. | Rewritten for 512-bit words with upstream's revert conditions; 33 overflow vectors confirmed |
| Q2 | High | hypc `f570687a` auto-getters read the wrong slot for `address`, `intN` and `bytesN` keys: `balanceOf`, `allowance`, `getPair`, `getPool`, `ticks`, `tickBitmap`, `positions` would all read zero (OC-V3-02). Routers resolving pairs through `getPair` would fail. | Private mappings behind explicit views; `npm run check:qrvm` lint |
| Q4 | High | `Quoter` reverts with the top half of a scratch word, so every quote would fail to decode. `BytesLib`/`Path` assume 20-byte addresses and 32-byte words. | Rescaled; quotes equal swaps on chain, multi-hop paths work |
| Q1 | Design | No contract can compute a QIP-55 CREATE2 address (Keccak-512 is not exposed). | Factory lookups; off-chain formula verified against live pairs and pools |
| Q5 | Design | The V3 pool is 851 bytes over MaxCodeSize even at 1 run, and its init code cannot be embedded anywhere. | `Oracle` linked, snapshot moved to a lens, split-code factory |
| Q7 | Low | qrl-contracts `main` re-raises a rejecting SQRC-TN1 receiver's revert with 256-bit offsets, so the reason is lost on QRVM. The npm release cannot be used on QRVM at all (`Strings` casts through `uint160`). | PauliSwap unaffected beyond the lost reason; to report upstream |
| — | Info | QRVM renumbers opcodes (`DUP1` = `0xa0`). The first chunk deploy, with hand-assembled EVM numbering, failed. | Init code without DUP |

## Not covered

- Only the sequences in the scenario were run. There was no fuzzing or
  invariant testing of the pool on QRVM, and nothing ran over time. The oracle
  and the lens were checked for answering with the right shape; their
  time-dependent values were not compared.
- The time-weighted accumulators were not compared with the reference: V2
  `price0CumulativeLast` was only checked to advance, and V3 `observe` values
  only for shape. `UQ112x112` has no assembly and `unchecked` wraps at 2²⁵⁶ on
  QRVM, so the risk is low, but these are the only core paths without a
  reference comparison.
- The compiler is a pre-release. The checks cover the paths exercised here, not
  every construct hypc can emit.
- Nothing was run through the public `/rpc/private-testnet` endpoint or a
  wallet proxy with a request-size cap.
- The lens is equivalent to upstream by construction and answers on chain, but
  upstream's tests for `snapshotCumulativesInside` were not replayed against it.

## Reproduce

```
# tunnel (QuantumArk/infra/devnet): npm run vps:tunnel
QRVM_ENV=.env.devnet npm run deploy:qrvm
QRVM_ENV=.env.devnet npm run audit:qrvm
QRVM_ENV=.env.devnet npm run diff:qrvm
```

Deployment costs about 0.02 QRL in gas. One scenario run locks up to about
30 QRL as WQRL and test liquidity. The deployer's leftover WQRL can be
recovered with `WQRL.withdraw`. Run the three commands one at a time, and only
when nothing else is signing with the same key. If the key runs
dry, claim another faucet drip (one per address per 24 h).
