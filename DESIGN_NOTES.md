# Design notes

Graders read this before the code. It covers the data model, every engine method added, what one `Ctrl+Z` reverts, the defects fixed in the starter engine, and how each budget was measured.

## Challenges

- **Challenge 1: range selection and fill handle.** The engine was rebuilt on stable row and column ids, and the grid was rebuilt as a virtualized canvas. Selection, editing, the fill handle, `$` references and one-step undo are done. Acceptance tests are in `src/engine/fill.test.js`.

## Data model

```
engine
├── rowAxis / colAxis        identity.js: position ⇄ stable id (ids are never reused)
├── cells   Map<key, Cell>   key = rowId * 65536 + colId
│     Cell = { raw: string|null, f: Formula|null, v: value }
│     Formula = { tpl, refs }  tpl is shared (pieces + AST), refs are bound to ids
├── styles  Map<key, Style>  only non-default styles; Style is a frozen full object
├── colWidths Map<colId, px>, rowHeights Map<rowId, px>
├── view    { frozenRows, frozenCols }
├── dependents Map<key, Set<key>> + rangeFormulas Set<key>
└── undoStack / redoStack: transactions of invertible ops
```

- **Row and column identity.** Every row and column has an id that never changes. A position is simply where that id currently sits in the axis order. Cells, styles, sizes and formula references are all keyed by ids. So:
  - inserting or deleting a row only splices the id order;
  - styles and sizes move with their rows and columns at no cost;
  - an inserted column gets a new id, so it has the default width while the old D keeps 300 px;
  - a formula's text is rendered from the current positions of the ids it refers to. After inserting a row above row 10, `=$G$2*H32` renders as `=$G$2*H33` without being rewritten. A reference to a deleted row renders `#REF!`, and undo brings the id back.
- **Formulas are parsed once.** `parseFormula` produces a template: the source split around its references, plus an AST whose reference nodes point into `refs` by index. A filled cell shares the seed's template and gets a new `refs` array, shifted for relative parts and unchanged for `$` parts. Filling 100,000 formula cells therefore never re-parses text.
- **Values.** A literal cell keeps its raw text for display, and its value is read leniently (`values.js` `toNum`): `$1,200.00` is 1200, `10%` is 0.1, and `2024-01-15` stays text. So `=G2*H2` works on the messy sample data, while the grid still shows `$1,200.00`.
- **Recalculation is incremental.** A change marks its transitive dependents dirty:
  - single-cell references are found through an exact reverse index;
  - formulas with ranges are found by a containment check;
  - only the dirty formulas are evaluated, precedents first, using an iterative DFS. A 20,000-long chain does not overflow the stack, and cycles evaluate to `#CYCLE!`.
- **No React state per cell.** React holds the engine's version number (`useSyncExternalStore`), the selection, the open editor and open menus. The canvas reads the engine directly.

## Engine API

Positions are 0-based. Every mutating method is one transaction, which is one undo step. A step that changes nothing creates no undo entry.

| Method | What it does | One undo reverts |
|---|---|---|
| `getCell(r, c)` | `{ raw, computed, error }` (unchanged contract) | – |
| `getText(r, c)` | what the grid shows before number formats | – |
| `getDisplay(r, c)` | what the grid paints | – |
| `getStyle(r, c)` | full style object (defaults filled in) | – |
| `getUsedRange()` | bounding box of non-empty cells `{ r1:0, c1:0, r2, c2 }` or `null` | – |
| `setCell(r, c, raw)` | edit one cell (no-op if unchanged) | that edit |
| `setCells(r0, c0, matrix, label)` | write a block of raw values (sample load, paste) | the whole block |
| `clearRange(range)` | clear contents (styles stay) | the whole clear |
| `setStyle(range, patch)` | merge a partial style into every cell of the range | the whole formatting |
| `fill(source, target)` | fill-handle semantics (below); a target inside the source clears the cells it no longer covers | the whole fill |
| `insertRows(at, n)` / `deleteRows(at, n)` | structure; references and ranges adjust, refs to deleted rows become `#REF!` | the insert/delete, including restored cells, styles and formulas |
| `insertColumns(at, n)` / `deleteColumns(at, n)` | same for columns | same |
| `insertRow / deleteRow / insertColumn / deleteColumn (at)` | the original single-row/column API, kept | same |
| `getColWidth(c)`, `getRowHeight(r)` | sizes (default 100 / 24) | – |
| `setColWidths([{c,width}], label)`, `setRowHeights([{r,height}], label)` | resize | all sizes in the call |
| `setFreeze({ rows, cols })`, `frozenRows`, `frozenCols` | frozen panes | the freeze change |
| `transact(label, fn)` | run several mutations as one undo step | everything inside |
| `undo()`, `redo()`, `canUndo()`, `canRedo()`, `undoLabel()`, `redoLabel()` | history | – |
| `subscribe(fn)`, `version` | change notification for the UI | – |
| `ensureCapacity(rows, cols)` | grow the bounds (not undoable, allocates nothing per cell) | – |

### Fill rules (`fill.js`, pure)

Each line along the fill axis is filled from its own seeds. The value at offset `k` from the first seed is:

- **One plain-number seed:** a copy. **Two or more numeric seeds:** a linear trend (least squares), so `1, 2` gives `3, 4, …` and dragging up gives `0, -1, …`.
- **Text ending in a number** (`Item 1`, `Q4`, `2024-W01`, `ORD-1001`): the number steps by the average seed step (1 for a single seed). Zero padding is kept.
- **Dates in any of the three sample shapes:** each step adds the average seed delta in days, rounded per cell. Every generated cell is written in the format of the seed it cycles from, so `B2:B4 → B8` gives `2024-01-11, 2024-01-13, 1/16/2024, 2024-01-18`.
- **Weekday and month names** (short or long): they cycle, keeping the seed's case.
- **Formulas:** copied with relative references shifted. `$A$1`, `$A1` and `A$1` stay pinned on their `$` parts.
- **Anything else, or mixed seeds:** the seeds repeat.
- **Style:** a filled cell takes the style of the seed it cycles from.

## Undo semantics

Every user action is one engine transaction. A transaction records ops that can be applied in both directions: cell before/after, style before/after, axis insert/delete with the ids involved, size before/after, and view field before/after. Undo replays them in reverse, and redo replays them forward. Recalculation runs once at the end.

| Action | One `Ctrl+Z` reverts |
|---|---|
| Typing into a cell (Enter / Tab / arrow / click away) | that cell's content |
| Delete / Backspace on a selection | every cleared cell in the selection |
| Bold / italic / underline / size / colour / fill / alignment on a selection | the style change on every cell of the selection |
| Fill-handle drag, `Ctrl+D`, `Ctrl+R` | every filled cell (content and style), or every cell cleared by dragging back |
| Paste (`Ctrl+V`, tab-separated) | the whole pasted block |
| Load sample | the whole load |
| Insert / delete row or column | the structural change, including the cells, styles and formulas it removed |

## Defects found in the existing code

| Where | Symptom | Root cause | Fix |
|---|---|---|---|
| `parseTokensToAST`, range handling | `=SUM(A1:A2)*2` gives `#PARSE!` (the starter test fails) | The `:` token was handled when it was read, while only the first endpoint was in the output queue. So "Invalid range syntax" was thrown before the second endpoint existed. | The tokenizer reads `A1:B2` as one range token, and a recursive-descent parser replaces the shunting-yard parser. |
| `updateDependencies` / `extractCellReferences` | `=SUM(A1:A4)` does not update when A2 changes | Only the two endpoints of a range were registered as dependencies (the code even has a TODO). | Ranges are checked by containment against each changed cell's position. |
| `resolveCellValue` (literals) | `2024-01-03` displays as `2024`, and `1/8/2024` as `1` | `parseFloat` reads a numeric prefix, so any text starting with digits became a number and the grid showed that number. | Literal values use the strict `toNum` rule, and the grid shows the raw text for literals. |
| `shiftCellReferences` on delete | Deleting row 2 silently makes `=A2*10` point at the old row 3 | References at the deleted index were shifted like the ones after it. | References follow row ids, so a deleted row's id has no position and renders `#REF!`. Undo restores it. |
| `evaluateAST`, `AVG` | `AVG` over a range with blanks counts the blanks as 0 | `parseFloat('')` gave NaN, which was mapped to 0 and still counted. | Range functions skip blanks and text, as spreadsheets do. |
| `executeSetCell` | Every edit invalidates the whole cache (`_generation++`), so each keystroke commit re-evaluates every formula that is read | The generation counter used for structural changes was also bumped on every edit. | Incremental dirty propagation; cached values are trusted unless marked dirty. |
| `recalculate` | `sorted.includes` inside a loop, and `queue.shift()` in the topological sort | Both are O(n²) on large sheets. | Evaluation order comes from an iterative DFS over the dirty set. |
| `getAllDependentsRecursive` / `resolveCellValue` | A long chain (`A2=A1+1` filled down 20,000 rows) overflows the call stack | Both are recursive. | Iterative BFS and DFS. |
| `clearAllCells` (App) | "Clear all" pushes 2,500 undo entries and overflows the 100-entry history | Each cell was cleared with its own `setCell`. | `clearRange` is one transaction. |
| Cell styles (App) | Styles stay in place on insert/delete, and formatting can't be undone | Styles were React state keyed by `"row,col"`. | Styles live in the engine, keyed by cell identity, and are recorded in transactions. |

## Measurements

**Method.** Production build (`npm run build && npm run preview`), Chrome on an Apple-silicon MacBook, driven by a puppeteer script. Timings are `performance.now()` around the engine call, shown in the status bar (`src/ui/perf.js`).

| Budget | Result | How |
|---|---|---|
| Fill 5,000 cells < 200 ms | **median 2.2 ms**, worst 5.6 ms over 7 runs | Load `sales.tsv`, put `=J2/G2` in K2, type `A2:K456` in the name box, press `Ctrl+D` (11 × 454 = 4,994 cells: ids, dates, text, numbers and formulas), read the status bar, undo, repeat. |
| Same, cold, in Node | 21–58 ms | `src/engine/fill.test.js` ("fills 5,000 formula cells"), vitest, first run in a fresh process. |

## Trade-offs and what you would do next

- **Range formulas** are found by a containment scan over all range formulas for each changed cell. That's fine for tens of thousands of range formulas, but a column of 100,000 cumulative `SUM`s would need an interval index per column.
- **Formula language:** `+ - * / ^ &`, unary minus, parentheses, strings, and `SUM AVERAGE/AVG MIN MAX COUNT ABS ROUND`. There are no comparison operators and no `IF`.

## Use of AI tools

Claude Code was used for design discussion, code, tests, and a puppeteer script that runs the acceptance steps against the production build.
