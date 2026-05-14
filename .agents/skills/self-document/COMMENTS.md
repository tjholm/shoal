# Comments

Rules for eliminating noise comments and writing good doc comments. Apply during steps 3 and 4 of the process in [SKILL.md](SKILL.md).

Based on "Don't Write Comments" by [Code Aesthetic](https://www.youtube.com/@CodeAesthetic).

An inline comment (one inside a function body) is fine — even required — when it explains something the code cannot: why an unusual algorithm was chosen, why a workaround exists, what spec a constant implements. It becomes noise when it restates what the code already says (`// loops over users to find the most active`, `// increments user count`). The rules below target the noise.

## Eliminating noise comments

**1. Replace magic numbers with named constants.**
`if (status == ORDER_SHIPPED)` not `if (status == 3)`. `timeoutMs = SECONDS_PER_DAY * 1000` not `timeoutMs = 86400000`.

**2. Replace complex boolean conditions with named variables or predicate functions.**
If a condition needs a comment, break it into named booleans (`const hasLoyaltyDiscount = ...`) or extract a function whose name *is* the explanation. The `if` then reads like the original comment.

**3. Use types to convey semantics instead of comments.**
Return `Option<User>` / `User | undefined` / `(User, error)` instead of `null` with a comment "returns null if not found". Use an enum instead of magic integers with a comment mapping values. Use `time.Duration` or a `Meters` newtype instead of a raw number with a comment about units.

**4. Delete comments that merely restate what the code does.**
`i += 1  // increment i` is noise.

**5. Delete stale comments that contradict the code.**
Worse than no comment — actively misleads.

## Comments worth keeping

- **Non-obvious *why* explanations.** "We use a bitmap here because the key space is bounded to 256 values."
- **Links to specs or sources.** RFC numbers, paper citations, ticket numbers for the bug a workaround addresses.
- **Workarounds for upstream bugs.** "Chrome <120 mishandles X; remove once support is dropped."
- **Hidden invariants the type system cannot express.** "Caller must hold the lock." (Encode in types if possible.)

Test: would a future maintainer, looking only at the code, plausibly remove or rewrite this in a way that breaks something? If yes, the comment is load-bearing.

## Doc comments

**6. Every function and method should have a doc comment.**
One sentence. Describes *what* it does and *what* it returns — the interface, not the implementation.

**7. Every class or type should have a doc comment.**
One or two sentences on what it represents and its responsibility.

**8. Use the language's standard doc format.**
JSDoc (`/** */`) in TypeScript, godoc (`// FuncName ...`) in Go, docstrings (`"""..."""`) in Python, `///` in Rust.

**9. Doc comments should not repeat the function signature.**
Do not write `@param name the name`. Document parameters only when their purpose or constraints are not obvious (valid ranges, ownership, side effects).

**10. When types already express everything, keep the doc comment minimal.**
`findByEmail(email: string): Option<User>` needs only `/** Finds a user by their email address. */` — the return type covers the "not found" case.

## Decision flow

For each comment:

1. Explains *what* the code does → refactor (rename, extract, type) until redundant, then delete.
2. Explains *why* something non-obvious → keep.
3. Stale or contradicts the code → delete.
4. Public API doc comment → keep, but check whether better names or types could shrink it.
