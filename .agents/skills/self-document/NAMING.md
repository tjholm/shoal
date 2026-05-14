# Naming

Rules for variable, function, type, and module names. Apply during step 2 of the process in [SKILL.md](SKILL.md).

Based on "Naming Things in Code" by [Code Aesthetic](https://www.youtube.com/@CodeAesthetic).

## Variables and parameters

**1. Never use single-letter names.**
Exception: `i`, `j`, `k` as loop indices in trivial loops. Otherwise `customer` not `c`; `event` not `e`.

**2. Limit abbreviation.**
`documentManager` not `dm`. `transaction` not `txn`. Autocompletion eliminates the typing cost; abbreviations force every reader to decode.

Idiomatic exceptions (follow the language community):

- **Go:** `ctx context.Context`, `err error`, single-letter receivers (`func (s *Server) ...`).
- **TypeScript / Node:** `req`, `res`, `next` in middleware; `err` in callbacks.
- **Rust:** `f` for a `Formatter` in `fmt::Display` impls; short lifetimes (`'a`).
- **Python:** `cls`, `self`.

When in doubt, write it out.

**3. Do not encode types in names** (no Hungarian notation).
`count` not `intCount`. `users` not `arrUsers`. The type system already says it; two sources of truth drift apart.

**4. Include units when the type does not convey them.**
`delaySeconds` not `delay`. `distanceMeters` not `distance`. `maxRetries` not `max`.

Better: use a typed value so unit ambiguity is impossible.

- **TypeScript:** branded types — `type Meters = number & { readonly __brand: "Meters" }`.
- **Go:** named types — `type Meters float64`; `time.Duration` for time.
- **Rust:** newtypes — `struct Meters(f64)`; `std::time::Duration` for time.
- **Python:** `NewType("Meters", float)`; `datetime.timedelta` for durations.

## Types and interfaces

**5. Do not prefix interfaces with `I`.**
`Serializable` not `ISerializable`. Applies to TypeScript interfaces, Go interfaces, Rust traits, and Python protocols.
*Exception:* C# codebases where `I` prefix is already established project-wide.

**6. Do not use `Base`, `Abstract`, or similar in type names.**
If you struggle to name the parent, rename the child to be more specific and give the parent the natural general name. `Email` (parent) and `NotificationEmail` (child), not `BaseEmail` and `Email`.

## Modules and packages

**7. Never name a module, package, class, or file `Utils`, `Helper`, `Manager`, or `Common`.**
Buckets for things that did not have a home. Standard libraries never have a `Utils` module. Go is especially strict: the package name appears at every call site, so `utils.DoThing()` is permanently ugly.

Restructure based on what the function operates on:

- **Move methods to the type they operate on** when a function inspects or transforms a single value.
  - *TypeScript:* `StringUtils.formatCurrency(amount, code)` → `new Money(amount, code).format()`.
  - *Go:* `utils.FormatMoney(m Money)` → `func (m Money) Format() string`.
  - *Rust:* `format_money(m: &Money)` → `impl Money { fn format(&self) -> String }`.
  - *Python:* `MoneyUtils.format(m)` → `Money.format(self)`.

- **Move functions to a module named for the domain, not the mechanism** when the operation spans values or is a pure transform.
  - *TypeScript:* `utils/text.ts` → `formatting/text.ts` exporting `truncateWithEllipsis`, `slugify`.
  - *Go:* `package utils` → `package text` with `func TruncateWithEllipsis(...)`.
  - *Rust:* `mod utils` → `mod text` with `pub fn truncate_with_ellipsis(...)`.
  - *Python:* `utils.py` → `text_formatting.py` with module-level functions.

- **Make collections first-class.** A function operating on a list of orders belongs on an `Orders` type (or in an `orders` package), not in `OrderUtils`. In Go: `type Orders []Order` with methods.

Test: could a newcomer guess where a given function lives from the module name alone? If not, the name is wrong.

## Functions

Describe what the function does, not how. `scheduleOrExpireOrder` beats `proc`. A name that needs a comment needs more words.

A function whose name contains "and" (`validateAndSave`) is often two functions. Split; or, if joined, the joined operation should itself be a meaningful concept.

## When the codebase disagrees

Follow the existing convention. Consistency beats abstract correctness. Surface the conflict to the user — they may want to fix it project-wide.
