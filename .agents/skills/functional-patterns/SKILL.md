---
name: functional-patterns
description: "Refactor imperative loops into functional data pipelines using map, filter, reduce, sort, and slice. Replace procedural data processing with declarative transformations."
user-invocable: true
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# Functional Patterns

When invoked, review the specified code for imperative loops that transform, filter, or aggregate data. Refactor into functional data pipelines using the language's built-in higher-order functions. The goal is declarative code that clearly states *what* happens to the data, with the *how* handled by well-known primitives.

If the user has not specified a scope (file or directory), ask them which file or directory to focus on before proceeding.

## Core Rules

1. **Use `filter` to select elements matching a condition.** Replaces loops with `if` + `append`. The predicate function declares which elements to keep.

2. **Use `map` to transform each element.** Replaces loops that build a new list of transformed items. The mapper function declares what each element becomes.

3. **Use `reduce`/`fold` to aggregate a collection into a single value.** Replaces loops with an accumulator variable. The reducer function declares how elements combine.

4. **Use `sort` with a comparator function.** Replaces manual sorting loops or insertion-based ordering. The comparator declares the ordering criterion.

5. **Use `slice`/`take` to limit results.** Replaces counter-based early exits from loops.

6. **Chain operations into data pipelines.** Order the chain logically:
   - **Filter first** -- reduce data volume early to avoid unnecessary work.
   - **Map second** -- transform remaining elements into the shape you need.
   - **Sort third** -- order the transformed results.
   - **Slice last** -- take only what you need from the sorted results.

7. **Use lambda/arrow functions for short predicates and transformers.** A one-line lambda is more readable inline than a named function in a different location. Extract to a named function only when the logic is complex enough to benefit from a descriptive name or when it is reused.

8. **Do not force functional style where it does not fit.** Side-effectful operations -- database writes, API calls, file I/O, sending notifications -- should remain imperative. Functional pipelines are for data transformation, not orchestration. If a loop's body performs side effects on each iteration, it is not a candidate for `map`.

9. **Watch for performance implications.** Chaining `filter`, `map`, and `sort` creates multiple passes over the data. For small-to-medium collections (typical business logic), this is negligible. For very large datasets or hot paths, a single-pass loop may be warranted -- add a comment explaining why the imperative form is intentional.

10. **Prefer pure functions.** Functions in the pipeline should take inputs and return outputs without modifying external state. This makes each step independently understandable and testable.

## Language-Specific Idioms

Adapt to the language of the user's codebase:

- **JavaScript/TypeScript:** Method chaining on arrays -- `.filter().map().sort().slice()`. Use arrow functions.
- **Python:** List comprehensions for simple filter+map (`[x.name for x in items if x.active]`). Use `sorted()` with `key=`. Use `itertools` for advanced patterns. Generator expressions for lazy evaluation.
- **Java:** Streams API -- `stream().filter().map().sorted().limit().collect()`.
- **C#:** LINQ -- `.Where().Select().OrderBy().Take()`.
- **Rust:** Iterator chains -- `.iter().filter().map().sorted().take().collect()`.
- **Go:** No built-in higher-order functions on slices (pre-generics). Use `slices` package or simple loops. Do not force functional style in Go -- idiomatic Go uses explicit loops.

## Procedure

1. **Identify candidate loops.** Look for `for`/`while` loops that:
   - Build up a result list by appending conditionally (→ filter).
   - Build a new list by transforming each element (→ map).
   - Compute a single aggregate value from a collection (→ reduce).
   - Sort elements by comparison (→ sort).
   - Stop after N results (→ slice/take).
   - Combine two or more of the above.

2. **Classify each loop by purpose.** A single loop often combines filtering and mapping. Decompose it into its constituent operations.

3. **Rewrite using higher-order functions.** Chain them in pipeline order. Use the language's idiomatic syntax.

4. **Preserve behavior.** The refactored code must produce identical results. Pay attention to:
   - Order of elements (filter preserves order, sort changes it).
   - Handling of empty collections.
   - Side effects in the original loop body -- if present, the loop is not a candidate for pure functional refactoring.

5. **Present changes** with a brief explanation of what each pipeline step does.

---

## Examples

### Example A: Filter + Map Pipeline

An imperative loop that selects employees and extracts their names:

**Before:**

```typescript
function getSeniorEngineerNames(employees: Employee[]): string[] {
    const result: string[] = [];

    for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        if (emp.department === "Engineering") {
            if (emp.yearsOfService > 5) {
                result.push(emp.firstName + " " + emp.lastName);
            }
        }
    }

    return result;
}
```

The loop mixes three concerns: iterating, filtering, and transforming. The nested `if` statements obscure the intent.

**After:**

```typescript
function getSeniorEngineerNames(employees: Employee[]): string[] {
    return employees
        .filter(emp => emp.department === "Engineering" && emp.yearsOfService > 5)
        .map(emp => `${emp.firstName} ${emp.lastName}`);
}
```

The pipeline reads as a declaration: "from all employees, keep the senior engineers, then extract their full names." Each step does one thing. No index variable, no temporary array, no nested conditions.

---

### Example B: Reduce for Aggregation

A loop that computes a running balance from a list of transactions:

**Before:**

```python
def calculate_balance(transactions):
    balance = 0
    overdraft_count = 0

    for txn in transactions:
        if txn.type == "credit":
            balance += txn.amount
        elif txn.type == "debit":
            balance -= txn.amount

            if balance < 0:
                overdraft_count += 1

    return {"balance": balance, "overdraft_count": overdraft_count}
```

The loop tracks two accumulators and mixes balance calculation with overdraft counting.

**After:**

```python
from functools import reduce


def apply_transaction(acc, txn):
    new_balance = (
        acc["balance"] + txn.amount if txn.type == "credit"
        else acc["balance"] - txn.amount
    )
    new_overdrafts = acc["overdraft_count"] + (1 if new_balance < 0 else 0)

    return {"balance": new_balance, "overdraft_count": new_overdrafts}


def calculate_balance(transactions):
    return reduce(apply_transaction, transactions, {"balance": 0, "overdraft_count": 0})
```

The reducer `apply_transaction` is a pure function: given the current accumulator and a transaction, it returns the new accumulator. The state transitions are explicit. The function can be tested independently with any single transaction and accumulator.

**Note:** In Python, a simple loop is often more idiomatic than `reduce` for complex accumulations. An equally valid refactoring keeps the loop but extracts the transaction application:

```python
def calculate_balance(transactions):
    state = {"balance": 0, "overdraft_count": 0}
    for txn in transactions:
        state = apply_transaction(state, txn)
    return state
```

This preserves the pure-function benefit while staying idiomatic. Use judgment about what reads best in the team's codebase.

---

### Example C: Full Pipeline (Filter + Map + Sort + Slice)

A procedural function that finds the most severe recent log entries:

**Before:**

```typescript
function getTopAlerts(
    logEntries: LogEntry[],
    maxAge: number,
    limit: number,
): AlertSummary[] {
    const now = Date.now();
    const results: AlertSummary[] = [];

    for (let i = 0; i < logEntries.length; i++) {
        const entry = logEntries[i];
        const ageMs = now - entry.timestamp;

        if (ageMs > maxAge) {
            continue;
        }

        if (entry.severity < Severity.Warning) {
            continue;
        }

        results.push({
            message: entry.message,
            severity: entry.severity,
            source: entry.source,
            ageMinutes: Math.round(ageMs / 60000),
        });
    }

    // Manual bubble sort (yes, this exists in real codebases)
    for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
            if (results[j].severity > results[i].severity) {
                const temp = results[i];
                results[i] = results[j];
                results[j] = temp;
            }
        }
    }

    // Take first N
    const limited: AlertSummary[] = [];
    for (let i = 0; i < Math.min(limit, results.length); i++) {
        limited.push(results[i]);
    }

    return limited;
}
```

25 lines of imperative code with two nested loops, a manual sort, index arithmetic, temporary variables, and a manual slice. The intent is buried under the mechanics.

**After:**

```typescript
function getTopAlerts(
    logEntries: LogEntry[],
    maxAge: number,
    limit: number,
): AlertSummary[] {
    const now = Date.now();

    return logEntries
        .filter(entry => {
            const ageMs = now - entry.timestamp;
            return ageMs <= maxAge && entry.severity >= Severity.Warning;
        })
        .map(entry => ({
            message: entry.message,
            severity: entry.severity,
            source: entry.source,
            ageMinutes: Math.round((now - entry.timestamp) / 60000),
        }))
        .sort((a, b) => b.severity - a.severity)
        .slice(0, limit);
}
```

The pipeline declares exactly what happens:
1. **Filter**: keep entries within the age window that are at least warnings.
2. **Map**: transform each entry into an `AlertSummary` with a human-readable age.
3. **Sort**: order by severity, most severe first.
4. **Slice**: take the top N.

No index variables, no temporary arrays, no manual sorting. Each step is independently readable and testable. The function went from 25 lines of mechanics to 12 lines of intent.
