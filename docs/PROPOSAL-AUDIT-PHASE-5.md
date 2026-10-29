# Proposal: close the gaps the on-chain audit left open

Status: proposed 2026-10-29, from phase 5 of the cross-repo TODO in
`pauli-swap-interface/TODO.md`. Due before anything moves to the public QRL
testnet; season 1 on the private devnet does not wait for it.

[ONCHAIN-AUDIT.md](ONCHAIN-AUDIT.md) "Not covered" lists what the devnet run
did not test. This proposal turns that list into work, plus the two upstream
items.

## 1. Fuzz and invariant tests on QRVM (TODO 5.1)

The scenario run exercised fixed sequences only. QRVM's 64 byte words and the
rewritten `FullMath` (Q3) make the pool the place where a ported bug would
hide.

- [ ] V2 pair: random `mint` / `burn` / `swap` / `skim` / `sync` sequences;
      `k` never decreases, reserves equal balances after `sync`, LP supply
      matches the first-deposit minimum.
- [ ] V3 pool: random swaps and position changes across tick boundaries;
      `liquidity` equals the sum of in-range positions, fee growth never
      decreases, `slot0` tick matches `sqrtPriceX96`.
- [ ] `FullMath` / `TickMath` / `SqrtPriceMath`: differential fuzz against a
      BigInt reference at 512 bit words, the edges of the 33 overflow
      vectors included.

## 2. Time-dependent values (TODO 5.1)

- [ ] V2 `price0CumulativeLast` / `price1CumulativeLast` against a reference
      computed from `Sync` events and block timestamps, over at least a day
      of devnet blocks.
- [ ] V3 `observe` against the same reference built from `Swap` events,
      cardinality grown past 1.
- [ ] Replay upstream's `snapshotCumulativesInside` tests against
      `PauliV3PoolLens`.

## 3. Transport limits (TODO 5.1)

- [ ] Deploy and trade through the public `/rpc/private-testnet` endpoint and
      through a wallet proxy with a request-size cap. The split-code factory
      (Q5) sends the largest transactions; record the largest calldata that
      gets through.

## 4. Upstream and compiler (TODO 5.2)

- [ ] Report Q7 to `qrl-contracts`: a rejecting SQRC-TN1 receiver's revert
      reason is re-raised with 256 bit offsets and lost on QRVM.
- [ ] Track `hypc` releases. On each one: recompile, rerun `check:qrvm`
      (OC-V3-02 lint) and the whole on-chain audit, and update QRVM.md.

## Done when

ONCHAIN-AUDIT.md "Not covered" is empty or every remaining line says why it
stays out of scope. Then this file can go.
