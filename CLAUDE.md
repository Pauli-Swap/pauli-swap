# Project coding rules

These rules are binding for every change made in this repository. They override
default assistant behaviour and any general style habit.

## 1. No filler comments

Do not add a comment that only restates what the code already says. A reader who
knows the language must learn something new from every comment, or the comment
does not belong in the file.

Write a comment only when at least one of these is true:

- The logic is genuinely hard to infer from the code alone (bit tricks, fixed
  point math, overflow that is intentional, a non-obvious invariant).
- The reason for the code lives somewhere else and cannot be reached from this
  file (a protocol constraint, a chain quirk, a deliberate deviation from the
  upstream reference, a workaround for a compiler or node bug).
- It is a NatSpec / API doc block on a public or external interface.

Delete on sight:

```
// increment the counter
i++;

// constructor
constructor() { ... }

// loop through the array
for (uint256 i = 0; i < n; i++) { ... }
```

Keep, because the reason is not recoverable from the code:

```
// Overflow is desired: the accumulator is only ever read as a difference
// between two observations, so wrapping preserves the delta.
unchecked { priceCumulativeLast += price * timeElapsed; }
```

Commented out code is not documentation. Remove it; version control keeps it.

## 2. Comments in English

All comments, NatSpec, commit messages, identifier names and log strings are
written in English, regardless of the language used in the conversation that
produced the change.

---

## Applying these rules to existing code

When editing a file that already violates the rules, fix only the comments in
the region you are already touching. Do not open a repo wide comment cleanup
unless asked.

Comments inherited from an upstream reference implementation (Uniswap, QRL
contracts) are kept as they are when the code is a faithful port. If the port
deviates from upstream, the deviation is commented, and the reason for it.
