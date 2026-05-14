---
name: self-document
description: "Improve readability by fixing names and eliminating unnecessary comments. Replace magic numbers, abbreviations, and comments with expressive names, variables, functions, and types."
user-invocable: true
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# Self-Document

Refactor names and structure so the code speaks for itself, then add concise doc comments where callers need them.

If the user has not specified a scope, ask which file or directory to focus on before proceeding.

## Glossary

- **Inline comment** — a comment inside a function body. Earns its place when it explains a non-obvious *why* (algorithm choice, optimization, workaround for an upstream bug, regulatory requirement). Becomes noise when it restates *what* the code does ("loops over users", "increments count"). Most existing inline comments are noise.
- **Doc comment** — a comment above a function, method, or class. Documents the interface for callers. Keep and add these.
- **Self-documenting** — readable without *what*-comments because names, types, and structure carry the meaning.
- **Magic number / magic value** — a literal whose meaning is not obvious from its value (`86400`, `3`, `"PENDING"` if it is one of several states). Replace with a named constant or enum.
- **Load-bearing comment** — a comment a caller would actually break things by ignoring (e.g. "returns null if not found", "weight in grams"). The fix is almost always to push the meaning into the type system, not to keep the comment.

## Principles

- **Types are documentation; comments are the fallback.** If a type can express the constraint (`Optional<User>`, `Duration`, an enum, a newtype), prefer that. Reach for a comment only when the type system cannot carry the meaning.
- **Names should make comments redundant.** A comment explaining a variable, condition, or constant means the name is doing too little work. Rename or extract until the comment is restating the code, then delete it.
- **Comments must justify themselves.** A *why* comment (non-obvious choice, optimization, workaround) earns its place. A *what* comment (restating the code) is noise — refactor and delete. This applies wherever the comment lives.
- **Stale comments are worse than no comments.** A comment that contradicts the code actively misleads. Delete on sight.

## Process

1. **Scope.** Confirm which file or directory to work on. Read it first to learn the codebase's conventions (case style, doc-comment format, idiomatic abbreviations like `ctx` in Go).

2. **Apply the naming rules.** Find single-letter variables, abbreviations, type-prefixed names, `Utils`/`Helper`/`Manager`/`Common` containers, and `Base`/`Abstract`/`I`-prefixed types. Rename or restructure. See [NAMING.md](NAMING.md).

3. **Apply the comment rules.** For every comment, decide: does it restate the code (delete), explain a non-obvious *why* (keep), document a public API (keep, but check if naming/types can shrink it), or contradict the code (delete). For each one you delete, ask whether a named constant, extracted predicate, or richer type would carry the meaning the comment used to. See [COMMENTS.md](COMMENTS.md).

4. **Add doc comments where missing.** Every function, method, and class should have a one-sentence doc comment in the language's standard format (JSDoc, godoc, docstrings, `///`). Describe the interface, not the implementation. See [COMMENTS.md](COMMENTS.md).

5. **Present changes.** Group edits by rule (naming, magic numbers, comment removal, doc comments added) so the user can review each category independently.

See [EXAMPLES.md](EXAMPLES.md) for worked before/after examples.

## Adapt to the codebase

Follow existing conventions: case style, doc-comment format, idiomatic abbreviations. Use language-specific type features (`Optional`, `Result`, enums, newtypes) where available. If the codebase has an established convention that conflicts with a rule here (e.g. `I`-prefix interfaces in C#), follow the codebase.

---

_Based on "Naming Things in Code" and "Don't Write Comments" by [Code Aesthetic](https://www.youtube.com/@CodeAesthetic)._
