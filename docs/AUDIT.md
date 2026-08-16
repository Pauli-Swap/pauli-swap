# AcornSwap — port review against QRL Zond testnet v2

Scope: the Uniswap V2 and V3 forks in `contracts/`, reviewed for correctness of
the port and for fitness against the QRL Zond testnet v2 (`chainId` 1337).

Toolchain at the time of review: `@theqrl/hypc` 0.0.2
(`0.0.2+commit.3e18e55d`), `@theqrl/qrl-contracts` 0.1.0, target node
`theQRL/go-zond`.

Upstream references:

- `Uniswap/v2-core`, `Uniswap/v2-periphery` (`@uniswap/v2-core@1.0.1`,
  `@uniswap/v2-periphery@1.1.0-beta.0`)
- `Uniswap/v3-core` v1.0.0, `Uniswap/v3-periphery` v1.3.0
- `theQRL/go-zond`, `theQRL/hyperion`, `theQRL/qrl-contracts`

---

## 1. Findings that changed the design

### 1.1 Zond has no `ecrecover` — every signature based approval is removed

`go-zond/core/vm/contracts.go` registers only four precompiles
(`PrecompiledContractsZond`): `0x01` is `depositroot`, `0x02` `sha256`, `0x04`
`identity`, `0x05` `modexp`. There is **no** `ecrecover` at `0x01`, and the
Hyperion compiler rejects the identifier outright:

```
contract T { function f(bytes32 h, uint8 v, bytes32 r, bytes32 s) external pure returns (address) {
    return ecrecover(h,v,r,s); } }
// DeclarationError: Undeclared identifier.
```

This is structural, not a gap: Zond accounts are ML-DSA-87 (FIPS 204), so a
secp256k1 recovery has nothing to recover. Consequences applied to the port:

| Upstream feature | Status here |
| --- | --- |
| `UniswapV2ERC20.permit`, `DOMAIN_SEPARATOR`, `PERMIT_TYPEHASH`, `nonces` | Removed from `AcornV2SQRCTF1` |
| `UniswapV2Router02.removeLiquidity*WithPermit*` (3 entry points) | Removed from `AcornV2Router02` |
| `SelfPermit` on the V3 router | Not inherited by `SwapRouter` |
| `ERC721Permit` / `NonfungiblePositionManager.permit` | Not ported (see §4) |

**Impact on integrators:** every flow that Uniswap lets a user do in one
transaction with an off chain signature now needs an explicit `approve`
transaction first. Any front end copied from Uniswap that calls `permit` will
fail at ABI encoding, which is the desired loud failure rather than a silent
one.

**Not mitigated by:** ERC-1271 contract signatures. Upstream's V3
`ERC721Permit` falls back to ERC-1271 for contract owners, but that path only
exists alongside the `ecrecover` path and is not useful on its own here.

### 1.2 Address literals use a `Z` prefix, not `0x`

Confirmed against the compiler:

```
address constant A = Z1111111111111111111111111111111111111111;  // OK
address constant A = 0x1111111111111111111111111111111111111111;  // type error
```

Addresses remain **20 bytes**; only the source and JSON-RPC text form differ.
That is why `uint160(address)` casts, `CREATE2` derivation and ABI encoding are
all unchanged from Uniswap. `scripts/deploy.js` converts between the two forms
at the boundary (`toZond` / `toHex`).

No `Z` prefixed literal appears in the contracts — every address in this port is
runtime data — so this only affects tooling, not the ported logic.

### 1.3 Hyperion checks arithmetic by default; Uniswap relies on wrapping

Hyperion behaves like Solidity 0.8. Uniswap V2 targets 0.5.16/0.6.6 and V3
targets 0.7.6, all of which wrap silently. Every place where upstream *depends*
on wrapping had to be wrapped in `unchecked`, or the contract would revert in
normal operation rather than in an error case.

Sites converted, each with the reason recorded in the source:

- `AcornV2Pair._update` — `timeElapsed` and both price accumulators. Without
  `unchecked` the pair reverts permanently once the accumulator wraps.
- `Math.sqrt`, `UQ112x112.encode`.
- `FullMath.mulDiv` — the entire 512 bit reconstruction. Also
  `-denominator & denominator` had to become `(0 - denominator) & denominator`,
  because unary minus on an unsigned value is rejected in this dialect.
- `TickMath.getSqrtRatioAtTick` / `getTickAtSqrtRatio`.
- `SqrtPriceMath` — notably `(product = amount * sqrtPX96) / amount == sqrtPX96`,
  which *is* an overflow probe; leaving it checked would turn the fallback path
  into a revert.
- `SwapMath.computeSwapStep` — `uint256(-amountRemaining)`.
- `Tick.getFeeGrowthInside` / `Tick.cross`, `Position.update`, the whole of
  `Oracle`, and the fee growth and protocol fee accumulators in
  `AcornV3Pool.swap` / `flash` / `burn`.
- `LiquidityMath.addDelta` — see §2.1, this one was caught by a test.

`SafeMath` and `LowGasSafeMath` are therefore redundant. V2's is deleted; V3's
`LowGasSafeMath` is kept as thin operator wrappers so call sites still read like
upstream.

### 1.4 Contract size is the binding constraint on V3

`go-zond/params/protocol_params.go` sets `MaxCodeSize = 24576` and
`MaxInitCodeSize = 49152`, identical to Ethereum. `hypc` 0.0.2 produces larger
output than `solc` 0.7.6 for the same sources, and `AcornV3Factory` embeds the
pool's init code:

| optimizer runs | factory | pool |
| --- | --- | --- |
| 800 | 25218 (over) | 22653 |
| 400 | 24826 (over) | 22294 |
| **200** | **24432** | **21940** |
| 100 | 24202 | 21725 |

The build uses **200 runs for all of `contracts/v3/`**, leaving the factory about
144 bytes of headroom. Two guards make that tightness safe rather than fragile:

1. `scripts/compile.js` fails the build if any runtime exceeds `MAX_CODE_SIZE` or
   any init code exceeds `MAX_INIT_CODE_SIZE`.
2. `poolCodeHash()` — a convenience getter added during the port — was removed
   from `AcornV3Factory` to recover bytes. `AcornV2Factory.pairCodeHash()`
   is kept; V2 has ample room.

Anyone adding code to the V3 pool or factory should expect to lower the run count
further, and should not raise it.

Unlike Uniswap, this build compiles the whole of `contracts/v3/` as one unit at
one setting. Uniswap overrides only `UniswapV3Pool.sol` to 800 runs while the
factory compiles at 1,000,000, which means the pool artifact and the init code
embedded in the factory come from different compiler invocations. Compiling as
one unit makes the pool artifact and the factory's embedded init code identical
by construction — see §2.2.

---

## 2. Defects found and fixed during the port

### 2.1 `LiquidityMath.addDelta` reverted with a panic instead of `LS`/`LA`

The first port kept upstream's structure:

```
require((z = x + uint128(uint256(int256(y)))) >= x, "LA");
```

Under checked arithmetic the addition panics (`0x11`) before the `require` can
run, so the overflow guard was dead code and the error string was unreachable.
Callers that legitimately inspect the revert reason — and `Tick.update`, which
relies on `addDelta` reverting cleanly — would see the wrong failure.

Fixed by wrapping both branches in `unchecked`. `test/v3/math.test.js` asserts
`LS` and `LA` explicitly, which is how the bug surfaced.

### 2.2 CREATE2 init code hashes were placeholders

`AcornV2Library.PAIR_INIT_CODE_HASH` and `PoolAddress.POOL_INIT_CODE_HASH`
are hardcoded constants in Uniswap. A stale value does not fail loudly: the
router computes an address with no code and calls into nothing.

Handled by:

- `scripts/init-code-hash.js` regenerates both from the compiled artifacts;
  `npm run build` runs compile → hash → compile.
- `metadata: { bytecodeHash: 'none' }` so the hash depends only on sources and
  settings, not on a metadata digest.
- Tests assert the derived address equals the address the factory actually
  deployed, for both V2 (`test/v2/router.test.js`) and V3
  (`test/v3/periphery.test.js`).
- `scripts/deploy.js` re-checks the V2 hash against the live factory and aborts
  on mismatch.

### 2.3 `AcornV2Library.getAmountIn` had no reason string at the boundary

Upstream reaches a division by zero when `amountOut == reserveOut`. Both
versions revert, but upstream's gives a bare panic. An explicit
`require(amountOut < reserveOut, "AcornV2Library: INSUFFICIENT_LIQUIDITY")`
was added and marked in the source as a deviation.

---

## 3. Verification performed

`npm test` — 83 tests, all passing. Contracts are compiled with `hypc` and the
resulting QRVM bytecode is executed on a local EVM, which is sound here because
the bytecode `hypc` emits is standard 256-bit EVM (verified by deploying and
calling a probe contract before any porting work began).

What the suite actually pins:

- **V2 pricing is bit exact against Uniswap.** Seven swap cases assert the exact
  output amount Uniswap V2 produces (e.g. 1 in, reserves 5/10 →
  `1662497915624478906`) and that one wei more reverts with `AcornV2: K`.
- **V3 tick math is exact.** `getSqrtRatioAtTick` is asserted against reference
  values cross checked with an independent big integer computation, plus
  tick → ratio → tick round trips across the full range and both boundary
  reverts.
- **`FullMath` phantom overflow** behaves correctly at `2**256 - 1`.
- **End to end V3**: initialize, mint through the callback, swap in both
  directions, fee accrual and `collect`, `flash`, oracle `observe` and
  cardinality growth, protocol fee `setFeeProtocol` / `collectProtocol`, and
  `burn`.
- **Router paths**: exact input and exact output, single and two hop, slippage
  bounds, deadline, native QRL wrapping, `multicall` including inner revert
  reason propagation, and rejection of a forged swap callback.
- **Quoter agreement**: the quote equals the amount the subsequent real swap
  delivers.
- **Fee-on-transfer**: `DeflatingSQRCTF1` confirms the plain V2 router path
  reverts and the `SupportingFeeOnTransferTokens` path succeeds.

Additionally pinned since the first revision:

- **Tick crossing.** Narrow positions either side of the current price, swapped
  through in both directions, asserting liquidity drops on exit and returns on
  re-entry, `feeGrowthOutside` is recorded on crossed ticks, and tick state is
  cleared when the last position on it is burned. This is the path that
  exercises every `int24`/`uint24` conversion the port had to rewrite and the
  `unchecked` negation of `liquidityNet`.
- **Single sided mints** above and below the current price, and rejection of
  ticks off the spacing grid.
- **Oracle over time**: `tickCumulative` moving with the tick, older
  observations after a cardinality increase, `OLD` on an out of range lookback,
  and `snapshotCumulativesInside`.
- **`NoDelegateCall`**: `swap` and `observe` both fail when reached through a
  `delegatecall`.
- **V2 flash swap** via `IAcornV2Callee`, including a one wei underpayment
  reverting with `AcornV2: K`, and reserves matching balances afterwards.
- **V2 reentrancy**: a nested call from inside the swap callback hits
  `AcornV2: LOCKED`.
- **V2 allowance semantics** (infinite vs finite) and the absence of any
  `permit` / `DOMAIN_SEPARATOR` / `nonces` entry in the pair ABI.

### Verified on the live testnet

Acorn V2 is deployed to QRL Zond testnet v2 (chainId 1337):

| Contract | Address |
| --- | --- |
| WQRL (pre-existing, reused) | `Q823b2FAeEbC9e1EE8e20454201502ef0679cC4AE` |
| `AcornV2Factory` | `QA19FA6B49A10F1B57E303ECE95eF21acE640d312` |
| `AcornV2Router02` | `QE89663F7f2a4955A82a2852D1624f51569080916` |

An earlier deployment under the working name Hyperion Swap
(`Q2755080D…329263` / `Q0c62B46e…fd63E3`) is superseded and must not be used.
The rename changed contract names, revert strings and the LP token symbol, all
of which sit in the pair's bytecode, so `PAIR_INIT_CODE_HASH` moved from
`0x3bb56bfc…deba7` to `0x5fb17eaa…9c484` and the old factory became
unaddressable by the new router. It held no pairs and no liquidity.

`npm run verify` reads back, against the deployed contracts:

- `factory.pairCodeHash()` equals the compiled artifact hash
  (`0x5fb17eaa…9c484`), so the router's `pairFor` derives addresses the factory
  will actually deploy to. This is the single check that would silently break
  every router entry point.
- `router.factory()` and `router.WQRL()` point at the intended contracts.
- **`getAmountOut(1e18, 5e18, 10e18)` returns `1662497915624478906`, executed by
  the deployed contract on QRVM — bit identical to Uniswap V2.** This is the
  strongest available evidence that `hypc` codegen and QRVM execution agree with
  the reference implementation on the pricing path.
- The reused WQRL reports `name` "Wrapped QRL", `symbol` "WQRL" and holds
  100.19 QRL.

### Not verified

- **No state changing call has been made against the deployed contracts.** No
  pair has been created, no liquidity added, no swap executed on the testnet.
  Everything above is either a read, or a `pure` function evaluated on chain.
- **V3 is not deployed**, and cannot be through the wallet RPC. See §1.7.
- Gas costs under QRVM pricing are still uncompared.

### 1.5 Hardhat and ethers cannot deploy to Zond at all

Discovered after the first revision of this document, which wrongly implied that
an RPC endpoint accepting `zond_sendRawTransaction` would be sufficient. It is
necessary but nowhere near sufficient. Three independent blockers, each verified:

1. **Signature scheme.** `go-zond/core/types/transaction_signing.go` uses
   `ZondSigner` with `pqcrypto.MLDSA87VerifySignature`, and derives the sender
   via `pqcrypto.PublicKeyAndDescriptorToAddress(...)`. There is no `ecrecover`
   anywhere in the path. A transaction carries `rawSignatureValue`,
   `rawPublicKeyValue`, `descriptor` and `extraParams` — not ECDSA `r`/`s`/`v`.
   ethers signs secp256k1 and cannot produce this.
2. **Transaction type.** `DynamicFeeTxType = 0x02` is the only type `decodeTyped`
   accepts; everything else returns `ErrTxTypeNotSupported`.
3. **Mnemonic format.** QRL mnemonics are 34 words encoding a 48 byte seed.
   `ethers.Mnemonic.fromPhrase` rejects the project's phrase with
   `invalid mnemonic length`, since BIP-39 allows only 12/15/18/21/24.

Hardhat remains valid as a **test** rig, because the bytecode `hypc` emits is
standard 256-bit EVM and executes correctly on a local EVM. It is not valid as a
deployment path. `scripts/deploy.js` now runs on `@theqrl/web3` with the account
derived by `@theqrl/wallet.js`.

### 1.7 The wallet RPC caps request bodies, which excludes the V3 factory

Two corrections to an earlier revision of this document, both of which had
concluded the endpoint was unusable:

1. **The JSON-RPC namespace is `qrl_`, not `zond_`.** Despite the node being
   go-zond, `zond_*` returns `-32601 Method not allowed` while `qrl_*` works.
   That error code reads like an access restriction, which is what caused the
   misdiagnosis. `qrl_sendRawTransaction` is available.
2. **The endpoint does deploy**, but caps a request body at roughly 51,180 bytes
   (`Request body too large`), measured by binary search.

An ML-DSA-87 signature (4,627 bytes) plus public key (2,592 bytes) rides inside
every transaction, so a signed deployment is about 7.3 KB larger than its init
code, and the hex encoding doubles it in the JSON body. Deployable init code
through this endpoint is therefore about **18,250 bytes**:

| Contract | init code | fits |
| --- | --- | --- |
| `AcornV2Factory` | 12,442 | yes |
| `AcornV2Router02` at 999999 runs | 20,428 | no |
| `AcornV2Router02` at 200 runs | 15,328 | yes |
| `SwapRouter` | 8,174 | yes |
| `Quoter` | 4,181 | yes |
| `AcornV3Factory` at `runs: 1` | 24,498 | **no** |

`AcornV3Factory` embeds the pool's init code, so no optimizer setting brings
it under the cap.

**V3 deployment is therefore parked on infrastructure, not on the code.** The
agreed plan is to wait for an RPC endpoint without a body cap and then run
`npm run deploy:v3` unchanged. The alternative — splitting the pool deployer out
of the factory — was considered and rejected for now: it changes the CREATE2
base address that `PoolAddress.computeAddress` derives from, which would mean a
new `POOL_INIT_CODE_HASH`, a re-audit of the address derivation, and a design
that diverges from Uniswap V3 for a reason unrelated to the chain.

This is why `contracts/v2/core/` and `contracts/v2/periphery/` now compile at
different run counts: the core's count is frozen into `PAIR_INIT_CODE_HASH` and
the factory was already deployed, so only the periphery could be shrunk.

### 1.6 The QRL stack has split into two incompatible address generations

Deriving the same mnemonic across published versions:

| Package | 20 byte | 64 byte |
| --- | --- | --- |
| `@theqrl/wallet.js` | ≤ 5.1.0 | ≥ 6.0.0 (2026-05-20) |
| `@theqrl/web3` | ≤ 1.0.1 (via `wallet.js` 2.0.2) | ≥ 1.0.2 (via `wallet.js` 6.2.3) |
| `@theqrl/hypc` | 0.0.2, sole release (2025-02-21) | none published |

The 20 byte address is a prefix of the 64 byte one, so a version drift produces
a *plausible but wrong* account rather than an error.

This project targets the 20 byte generation, because that is what `hypc` 0.0.2
compiles for and what the reused WQRL contract
(`Q40b39fb95039801748ecbdb8245059075a1da0b4`, 40 hex) is. `@theqrl/web3` is
pinned to exactly `1.0.1` and `scripts/account.js` asserts the derived width.

**This raises the §5 forward compatibility risk from a future concern to a live
one.** The node and wallet libraries have already moved; only the compiler has
not. If the testnet itself has migrated, no Hyperion contract can currently be
compiled for it with published tooling. This cannot be resolved from here
because the available RPC endpoint answers no state queries.
- **Gas costs are not representative.** Local execution uses EVM gas schedules;
  QRVM pricing has not been compared.
- No fuzzing, no formal verification, no economic or MEV review.

---

## 4. Deliberately not ported

| Upstream contract | Reason |
| --- | --- |
| `SelfPermit`, `ERC721Permit` | Require `ecrecover` (§1.1) |
| `NonfungiblePositionManager`, `LiquidityManagement`, `PoolInitializer` | Needs an SQRC-TN1 base and a descriptor; deferred |
| `NonfungibleTokenPositionDescriptor`, `NFTDescriptor`, `NFTSVG` | On chain SVG rendering; large, and blocked on the above |
| `V3Migrator` | Depends on the position manager |
| `QuoterV2`, `TickLens`, `PositionValue`, `OracleLibrary` | Lens contracts, not required for swapping or liquidity |
| `UniswapV2Migrator`, V1 interfaces | No V1 on this chain |
| `PeripheryPaymentsWithFee` | Optional fee-on-swap; not required |

Without a position manager, V3 liquidity must be provided by calling
`AcornV3Pool.mint` from a contract that implements
`acornV3MintCallback`. `contracts/test/AcornV3PoolCaller.hyp` shows the
shape but is a test fixture, not production code.

---

## 5. Risks to track

**Forward compatibility with the 64-byte address migration (high).** The
`main` branch of `theQRL/go-zond` declares `AddressLength = 64`,
`LogTopicLength = 64` and a `StorageValue64Length` commented as matching a
512-bit VM stack word, and `theQRL/qrl-contracts` ships a `MIGRATION-QIP55.md`
describing addresses as `Q` followed by 128 hex characters. The released
compiler this port is built with is on the 20-byte `Z` model — `hypc` 0.0.2
rejects both `Q`+128 and `Z`+128 literals and has no `uint512` type. If the
testnet moves to 64-byte addresses, `CREATE2` derivation, `abi.encodePacked`
packing in `PoolAddress` / `AcornV2Library` / `Position.get`, and the 20-byte
assumption in `BytesLib.toAddress` and the swap `Path` encoding all break at
once. Re-verify against the toolchain before any mainnet consideration.

**Compiler maturity (high).** `hypc` 0.0.2 is a pre-1.0 fork of `solc`. It has
had none of the scrutiny the `solc` releases Uniswap was audited against
received. The exact swap-amount tests are the strongest available evidence that
codegen is correct on these paths, but they are not a substitute for compiler
review.

**Unverified execution environment (high).** The port has never run on a Zond
node. Any QRVM divergence from EVM semantics — gas, opcode behaviour,
`CREATE2` address derivation, `staticcall` return handling — would not be caught
by this suite.

**Factory size headroom (medium).** 144 bytes. See §1.4.

**Upstream V2 known behaviours retained (informational).** The port is faithful,
so it inherits: `MINIMUM_LIQUIDITY` donation griefing on first mint, the
`price*CumulativeLast` oracle being manipulable within a block, and the
requirement that integrators use the `SupportingFeeOnTransferTokens` variants
for fee-on-transfer tokens. These are Uniswap design decisions, not port
defects.

**Test token realism (informational).** The suite uses well behaved tokens plus
one deflationary token. Rebasing tokens, tokens with more than 18 decimals, and
tokens that revert on zero-value transfer are not covered.
