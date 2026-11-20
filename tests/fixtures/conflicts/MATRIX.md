# Conflict permutation matrix

`scripts/conflict-lab-generate.mjs` renders each pattern below in every language it applies to, from small templates.
`npm run conflict-lab -- --matrix` runs them all through the conflict preparation of #444 and writes
`/tmp/conflict-lab-report.md`. The cases are not committed: the same seed always generates the same cases. The
`gen-*` directories here are a small committed sample, written with `--write-sample`.

## Patterns that should resolve automatically

Expected: **auto**. That is Merged, or merged by Git with no conflict, and equal to the expected result. Two results
are accepted when two orders are equally right (both sides add an item in the same spot).

| Pattern | Definition | Languages |
| --- | --- | --- |
| add-function | Both sides add a different function, method or CSS rule in the same spot. | TS, TSX, JS, Python, C#, Go, Rust, Java, CSS |
| add-import | Both sides add a different import at the end of the import block. | TS, TSX, JS, Python, C#, Go, Rust, Java |
| add-enum-member | Both sides add a different member at the end of one enum. | TS, TSX, JS, Python, C#, Go, Rust, Java, JSON, YAML |
| add-object-key | Both sides add a different key at the end of one object literal (a declaration in CSS). | TS, TSX, JS, Python, JSON, YAML, CSS |
| add-array-item | Both sides append a different item to one array literal. | TS, TSX, JS, Python, C#, Go, Rust, Java, JSON, YAML |
| add-struct-field | Both sides add a different field at the end of one struct, class or interface. | TS, TSX, Python, C#, Go, Rust, Java |
| add-match-arm | Both sides add a different case to one switch or match. | TS, TSX, JS, Python, C#, Go, Rust, Java |
| edit-adjacent-statements | Both sides edit different, adjacent statements of one function. | all code languages |
| edit-signature-vs-body | One side adds a parameter; the other edits the first statement of the body. | all code languages |
| edit-doc-vs-body | One side edits the doc comment; the other edits the body. | all code languages |
| move-vs-edit | One side moves a function below its neighbours; the other edits it. | all code languages |
| rename-vs-edit | One side renames a function and its caller; the other edits the function. | all code languages |
| reformat-vs-edit | One side only reformats a call over several lines; the other changes one argument. | all code languages |
| reorder-vs-edit | One side swaps two functions; the other edits one of them. | all code languages |
| identical-change | Both sides make the same change. | all, plus JSON, YAML, CSS |
| adjacent-lines | Each side edits a different one of two adjacent lines. | all, plus JSON, YAML, CSS |
| blank-line-split | One side edits the line before a blank line; the other edits the line after it. | all, plus JSON, YAML, CSS |

## Patterns that must not be Merged

Expected: **any-but-merged**. Check or Decide are both right. Merged is a wrong Merged.

| Pattern | Definition | Languages |
| --- | --- | --- |
| same-line-different | Both sides change the same statement differently. | all code languages |
| delete-vs-edit | One side deletes a function; the other edits it. | all code languages |
| rename-vs-new-use | One side renames a function; the other adds new code, next to it, that calls the old name. | all code languages |
| param-rename-vs-use | One side renames a parameter; the other adds a statement that uses the old name. | all code languages |
| same-constant-different | Both sides change the same constant to different values. | all, plus JSON, YAML, CSS |
| duplicate-definition | Both sides add a function with the same name and different bodies. | all code languages, CSS |
| duplicate-member | Both sides add an enum member or object key with the same name and different values. | all, plus JSON, YAML, CSS |

## Variation axes

The first variant of each pattern and language is the plain one: middle of the file, the language's usual indent, LF,
top level, small file. The other variants draw each axis from a seeded generator (`--seed`, `--variants`).

| Axis | Values |
| --- | --- |
| position | top, middle or end of the file |
| indent | 2 spaces, 4 spaces, tab (YAML: spaces only) |
| line endings | LF, CRLF |
| nesting | top level; inside a class, impl, receiver type, `config:` key or `@media`; one level deeper |
| size | small (2 neighbours); large (2,100+ lines of neighbouring functions or keys) |
