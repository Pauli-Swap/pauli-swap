# PauliSwap on QRVM — port to QIP-55 (64 byte addresses, 512 bit words)

Scope: the second build line of PauliSwap, for QRL networks that run QIP-55
("testnet v3"): 64 byte addresses rendered `Q` + 128 hex, and a VM whose stack
word is 512 bits. The 20 byte line that is live on testnet v2 (`docs/AUDIT.md`)
is untouched: same sources, same `PAIR_INIT_CODE_HASH`, same 107 tests.

| | 20 byte line (testnet v2) | QRVM line (QIP-55) |
| --- | --- | --- |
| Compiler | npm `@theqrl/hypc` 0.0.2 | hyperion `main` `f570687a` (`hypc:local`, 0.2.0-develop) |
| Output key | `zvm` | `qrvm` |
| Node | go-zond 20 byte | go-zond `b92884a3` (gqrl 0.3.3) |
| Client | `@theqrl/web3` 1.0.1 | `@theqrl/web3` 1.0.3, `@theqrl/wallet.js` 6.3.0 (npm aliases `qrl-web3-qip55`, `qrl-wallet-qip55`) |
| Sources | `contracts/` | `contracts/` with `contracts-qrvm/` overlaid unit for unit |
| Build | `npm run build` → `build/hyperion/` | `npm run compile:qrvm` → `build/qrvm/` |

The overlay keeps the unit names of the files it replaces, so imports resolve
the same way in both builds and `git diff --no-index contracts/<unit>
contracts-qrvm/<unit>` is the complete list of what changed for QRVM.
`npm run check:qrvm` fails the build if an overlaid contract changes its ABI
beyond the deviations listed below, or if any public mapping keyed by
`address`, `intN`, `bytesN` or a contract type survives (see Q2).

---

## Facts the port rests on

Every row was measured, not read from documentation: a probe contract compiled
with `hypc:local` and run on `gqrl --dev` at the devnet's commit, or the go-zond
source at that commit.

| Fact | Evidence | Consequence |
| --- | --- | --- |
| Stack and memory words are 512 bits | probe: `shl` loop counts 512 bits | every hard coded `0x20`/`31` in assembly is wrong |
| Free memory pointer is at `0x80`, initial value `0x100`; `bytes` data starts at `ptr + 0x40` | probe: `mload(0x40) = 0`, `mload(0x80) = 0x100`, first data byte at offset `0x40` | assembly reading `mload(0x40)` gets scratch space |
| ABI words are 64 bytes; `abi.encodePacked(address)` is 64 bytes; selectors stay 4 bytes | probe | revert data and return data sizes double |
| `mul` in assembly does not wrap at 2²⁵⁶ | probe: `shr(256, mul(MAX, MAX)) = 2²⁵⁶ − 2` | FullMath's 512 bit trick breaks (Q3) |
| High level `unchecked` uint256 arithmetic wraps at 2²⁵⁶; signed values in assembly are correct | probe | oracle and fee accumulators behave as upstream |
| Public mapping getters read the wrong slot for `address`, `intN`, `bytesN` keys; `uintN` keys are fine | probe: `bal(a) = 0` while `balManual(a) = 42`; same for `int24`, `bytes32`; `uint24` correct | OC-V3-02 (Q2) |
| CREATE2 address = `Keccak-512("QRL-ADDR-v1" ‖ 0xff ‖ deployer₆₄ ‖ salt₆₄ ‖ keccak256(initcode))`, a `bytes32` salt right padded | `crypto.CreateAddress2`; matched against a live CREATE2 | no contract can compute it (Q1) |
| The VM exposes only `KECCAK256`; precompiles are `0x01` depositroot, `0x02` sha256, `0x04` identity, `0x05` modexp | `core/vm/opcodes.go`, `contracts.go` | no Keccak-512 on chain |
| Opcodes are renumbered: pushes run to `PUSH64` (`0x60`–`0x9f`), so `DUP1` is `0xa0` | `core/vm/opcodes.go` | hand written bytecode must not assume EVM numbering |
| `MaxCodeSize` 24,576, `MaxInitCodeSize` 49,152 | `params/protocol_params.go` | V3 pool over the limit (Q5) |
| Libraries open with `PUSH64 <own address>` written at deploy time | deployed `Oracle` vs artifact | call protection, as in solc |

---

## Deviations from the 20 byte line

### Q1. Pair and pool addresses are looked up, not derived

Upstream computes a pair or pool address in place from the CREATE2 formula. On
QIP-55 that formula is Keccak-512 over a domain tag, which no contract can
evaluate. `PauliV2Library.pairFor` and `PoolAddress.computeAddress` therefore
read `factory.getPair` / `factory.getPool`. Both became `view`.

- A missing pair or pool yields `address(0)`. Every caller then makes a call
  into that address, which reverts, the same as upstream calling a computed
  address with no code.
- `CallbackValidation.verifyCallback` is unchanged in source and still requires
  `msg.sender == pool`. `msg.sender` is never zero, so a missing pool cannot
  validate.
- `PAIR_INIT_CODE_HASH` and `POOL_INIT_CODE_HASH` no longer exist on this line,
  so nothing pins the optimizer settings of the core.
- Off chain code derives addresses with `create2Address` in
  `scripts/qrvm/lib.js`, from `PauliV2Factory.pairCodeHash()` (salt
  `keccak256(token0 ‖ token1)`, 64 byte addresses) and
  `PauliV3Factory.poolCodeHash()` (salt `keccak256(abi.encode(token0, token1,
  fee))`, 64 byte words). The audit asserts both against live deployments.
- Cost: one external call per hop, about 2.6k gas on a cold factory.

### Q2. OC-V3-02: public mappings keyed by address, intN or bytesN

hypc `f570687a` generates getters that clean the key as a `uint256` before
hashing it, so they read a different slot. Internal reads are correct; only the
generated getter is wrong, which is why the 20 byte harness cannot see it. The
same defect is recorded in the Ark Staking audit as OC-V3-02.

Each affected mapping is now private, behind an explicit view with upstream's
name and signature, so the ABI does not change:

| Contract | Mapping |
| --- | --- |
| `PauliV2SQRCTF1` (and so `PauliV2Pair`), `WQRL`, `DeflatingSQRCTF1` | `balanceOf`, `allowance` |
| `PauliV2Factory` | `getPair` |
| `PauliV3Factory` | `getPool` |
| `PauliV3Pool` | `ticks`, `tickBitmap`, `positions` |

`feeAmountTickSpacing` (`uint24` key) and `observations` (array) are correct as
generated and stay public.

### Q3. `FullMath.mulDiv` silently truncated instead of reverting

Upstream's `mulDiv` builds a 512 bit product from `mul` and
`mulmod(a, b, not(0))`, assuming 256 bit words. On QRVM `not(0)` is 2⁵¹² − 1,
`prod1` is always zero, the `denominator > prod1` overflow check is skipped,
and the quotient is truncated to 256 bits. Measured with upstream's code
compiled for QRVM:

| Input | EVM | Upstream code on QRVM |
| --- | --- | --- |
| `mulDiv(MAX, MAX, MAX − 1)` | reverts | returns `0` |
| `mulDiv(2¹²⁸, 2¹²⁸, 1)` | reverts | returns `0` |
| `mulDiv(MAX, MAX, MAX)` | `MAX` | `MAX` |

Every swap, mint and burn goes through `mulDiv`, so this would turn an
overflow into a silently wrong amount. The QRVM `mulDiv` uses the word size
directly: `div(mul(a, b), denominator)` with the 512 bit product exact,
reverting on `denominator == 0` and on any bit above 256. Those are upstream's
revert conditions. `mulDivRoundingUp` is unchanged.

### Q4. Hard coded word sizes in assembly

| Site | Upstream | QRVM |
| --- | --- | --- |
| `PauliV2Factory.createPair` | assembly `create2(0, add(bytecode, 32), …)` | `new PauliV2Pair{salt}()`; a failed creation reverts rather than returning zero, so `CREATE2_FAILED` cannot occur |
| `BytesLib.slice` | 32 byte copy loop, masks `31`, pointer at `0x40` | 64 byte loop, masks `63`, pointer at `0x80` |
| `BytesLib.toAddress` | 20 bytes, shifted down 12 | 64 bytes, a whole word |
| `Path` | `ADDR_SIZE = 20` | `ADDR_SIZE = 64`: a hop is 67 bytes, a two pool path 198 |
| `Quoter` callback | `mload(0x40)`, `revert(ptr, 32)` | `mload(0x80)`, `revert(ptr, 64)`. Upstream's version reverts with the top half of a scratch word, so every quote would fail to decode |
| `Quoter.parseRevertReason`, `Multicall` | lengths `32`, `68` | `64`, `132` (`4 + 64 + 64`) |
| `PauliV3Pool.balance0/1` | `data.length >= 32` | `>= 64` |

`BytesLib.toUint24` is unchanged: the word it loads ends at data offset
`_start + 3` for any word size, because the length prefix is one word long.

### Q5. The V3 pool does not fit under MaxCodeSize

QRVM code is larger: 64 byte immediates and wider ABI handling. Measured,
legacy codegen:

| Variant | Pool runtime | Pool init |
| --- | ---: | ---: |
| As written, 200 runs | 25,692 | 26,364 |
| As written, 1 run | 25,427 | 26,099 |
| `viaIR`, 1 run | 25,668 | 26,285 |
| Without `snapshotCumulativesInside` | 24,821 | 25,493 |
| **`Oracle` linked + `snapshotCumulativesInside` in a lens (shipped)** | **23,787** | **24,459** |

Three changes, chosen to keep every state changing path and every revert
string of the pool identical:

1. **`Oracle` is an externally linked library.** `initialize`, `write`, `grow`,
   `observeSingle` and `observe` are `public`, so the pool reaches them by
   DELEGATECALL. Logic and storage layout are unchanged. The deploy script links
   the 64 byte placeholders.
2. **`snapshotCumulativesInside` moved to `PauliV3PoolLens`**, which recomputes
   it from `ticks()`, `slot0()` and `observe([0])` in the same block, with
   upstream's checks and reasons (`TLU`, `TLM`, `TUM`, bare revert on an
   uninitialized tick). Integrators call
   `lens.snapshotCumulativesInside(pool, lower, upper)`.
3. **Split code pool factory.** Even at 24,459 bytes the pool's init code
   cannot sit inline in any contract's runtime. `PauliV3PoolDeployer` keeps it
   as the runtime code of two chunk contracts, each prefixed with a STOP byte,
   and reassembles it with `EXTCODECOPY` before every CREATE2. This is the
   pattern of Balancer V2's `BaseSplitCodeFactory`. The factory exposes
   `poolCodeChunkA/B`, `poolCreationCode()` and `poolCodeHash()`. The factory
   constructor takes the two chunk addresses. The deploy script verifies the
   chunk code byte for byte and that `poolCodeHash()` equals the keccak256 of
   the locally linked pool init code.

V3 compiles at one optimizer run on this line. No init code hash is pinned
here, so the run count is free to change.

Gas, measured on the same scenario (QRVM vs the 20 byte EVM build): an exact
input single swap 161k vs 127k, a two hop swap 276k vs 212k, `createPool` 4.89M
vs 4.52M. The extra cost comes from 64 byte words, the DELEGATECALLs into
`Oracle` and the factory lookups.

### Q6. Hand written bytecode

The pool code chunks are deployed from hand assembled init code
(`codeChunkInitCode` in `scripts/qrvm/lib.js`): `PUSH2 len, PUSH1 14, PUSH1 0,
CODECOPY, PUSH2 len, PUSH1 0, RETURN`. It avoids `DUP`, whose number moved;
the first attempt used EVM's `DUP1 = 0x80`, which QRVM decodes as `PUSH33`.

### Q7. The position NFT stands on qrl-contracts `main`, not the npm release

`NonfungiblePositionManager` needs an SQRC-TN1 (ERC-721) base. The only
published `@theqrl/qrl-contracts`, 0.1.0, is 20 byte code: its `Strings`
casts `address` through `uint160`, which does not compile for 64 byte
addresses, and `SQRCTN1` imports `Strings`. The QIP-55 rewrite exists only on
the library's `main` branch, so the QRVM build resolves every
`@theqrl/qrl-contracts/...` import to commit `d3c84ee`, installed under the npm
alias `qrl-contracts-qip55` (`scripts/compile.js`). The 20 byte build keeps
0.1.0. `SQRCTN1Enumerable`, which neither release ships to npm, is vendored
from that commit into `contracts/vendor/` for both lines.

The contract sources are the same on both lines; nothing about the position
manager is overlaid. Two things in the dependency are still 256 bit code,
found by reading `main` and confirmed on chain where it matters:

| Site in qrl-contracts `main` | Effect on QRVM | Reaches PauliSwap? |
| --- | --- | --- |
| `SQRCTN1Utils.checkOnSQRCTN1Received` bubbles a receiver's revert with `revert(add(32, reason), mload(reason))` | The transfer still reverts and ownership is unchanged, but the reason is garbled: a receiver rejecting with `"Receiver rejects"` surfaces as 4 zero bytes (`<error 0x00000000>`) | Yes, on `safeTransferFrom` to a contract that rejects. Diagnostics only |
| `Strings.toString` writes digits from `add(buffer, add(32, length))` | Would write into the length word, not the data | No: `SQRCTN1.tokenURI` is overridden and nothing else calls it |

The descriptor (`PauliV3PositionDescriptor`) replaces upstream's SVG renderer,
whose `NFTSVG`/`Base64` helpers are assembly written for 32 byte words. It has
no assembly, so the same source is correct at either word size, and it writes
addresses from `abi.encodePacked`, which gives 40 hex digits on one line and
128 on the other with no width constant.

Sizes (runtime / init): `NonfungiblePositionManager` 19,412 / 20,159 on QRVM,
17,668 / 18,493 on the 20 byte build.

---

## Verification

| What | How | Result on the local QIP-55 chain |
| --- | --- | --- |
| Testnet line unaffected | `npm test` | 107 passing, `PAIR_INIT_CODE_HASH` unchanged |
| ABI compatibility and OC-V3-02 lint | `npm run check:qrvm` | passes; flags the three pool mappings on the unported sources |
| Math libraries | `npm run diff:qrvm`: 1,128 vectors (extreme ticks and prices, mulDiv overflow edges, wide random operands) through `TickMathProbe` and `PauliV2LibraryProbe` on both builds | 0 mismatches, including all 33 mulDiv overflow reverts |
| End to end | `npm run audit:qrvm`: one scenario on both builds, compared value by value | 105/105 values identical, 68/68 invariant checks, including the position NFT, descriptor, TickLens and V3Migrator leg (`onchain/local-qrvm.json`) |

The devnet run and its numbers are in `docs/ONCHAIN-AUDIT.md`.

## Running it

```
# once, from QuantumArk/infra/devnet: the hyperion main compiler and a QIP-55 node image
docker build -f docker/hypc.Dockerfile -t hypc:local .
docker build -f docker/gqrl.Dockerfile -t gqrl:local .

npm run compile:qrvm
npm run check:qrvm

# local QIP-55 chain for iteration
docker run -d --name pauli-qrvm-dev -p 127.0.0.1:8547:8545 gqrl:local --dev --dev.period 0 \
  --dev.gaslimit 60000000 --rpc.txfeecap 0 --http --http.addr 0.0.0.0 --http.api qrl,net,web3
# .env.local-qrvm: QRL_RPC_URL=http://127.0.0.1:8547, QRVM_NETWORK=local-qrvm, DEPLOYER_MNEMONIC=…

# private devnet: tunnel with `npm run vps:tunnel` in QuantumArk/infra/devnet, then
cp .env.devnet.example .env.devnet   # fill DEPLOYER_MNEMONIC
QRVM_ENV=.env.devnet npm run deploy:qrvm
QRVM_ENV=.env.devnet npm run audit:qrvm
QRVM_ENV=.env.devnet npm run diff:qrvm
```

`scripts/qrvm/lib.js` refuses any RPC that is not a private address unless the
env file sets `ALLOW_PUBLIC_RPC=1`, and it ignores `process.env`: Hardhat loads
the testnet `.env`, whose `QRL_RPC_URL` is the public 20 byte testnet.

## Not covered

- The compiler is a pre-release build of hyperion `main`. OC-V3-02 shows it has
  getter bugs the 20 byte compiler does not. The differential tests cover the
  math libraries and the end to end paths above, not every code path hypc can
  emit.
- No property based or invariant fuzzing of the pool on QRVM; the scenario and
  the vectors are fixed.
- The lens matches upstream by construction and is exercised on chain, but no
  upstream test of `snapshotCumulativesInside` was replayed against it.
- A public QIP-55 testnet behind the wallet proxy would cap requests at about
  18 KB of init code. On this line `PauliV2Router02` (18,033) is just over
  that and `PauliV2Factory` (17,942) just under; the devnet is reached
  directly, so neither was tested through such a proxy.
