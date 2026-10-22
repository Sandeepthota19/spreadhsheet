# Design notes

Graders read this before the code. It covers the data model, every engine method added, what one `Ctrl+Z` reverts, the defects fixed in the starter engine, and how each budget was measured.

## Challenges

- **Challenge 1: range selection and fill handle.** The engine was rebuilt on stable row and column ids, and the grid was rebuilt as a virtualized canvas. Selection, editing, the fill handle, `$` references and one-step undo are done. Acceptance tests are in `src/engine/fill.test.js`.
- **Challenge 2: sort and filter.** Sort is a physical edit: it permutes row ids. Filters are an undoable view that hides rows. Acceptance tests are in `src/engine/sort.test.js`.
- **Challenge 3: virtualized grid at scale.** The grid is 100,000 × 200: one canvas, prefix sums with binary search, four frozen panes, column/row resize, auto-fit, name box, `Ctrl+Home/End`, `Page Up/Down`. The used range and the layout are updated incrementally, so an edit does no O(sheet) work.
- **Challenge 4: ask your data.** `Ctrl+K` opens a side panel. A prompt goes to the provider; the reply is parsed and validated, run by `executeQuery` over the sheet's computed values, and shown as a result card. All 20 golden queries match, in Node (`src/ai/queryExecutor.test.js`) and in the browser.
- **Challenge 5: format with AI.** A `format_sheet` action is planned by a pure planner (`ai/formatPlan.js`) against the current sheet, previewed in plain words, and applied by `engine.applyFormat` as one undo step. Number formats are a display-only style. All 10 golden cases pass through the real engine (`src/ai/formatGolden.test.js`).

## Data model

```
engine
├── rowAxis / colAxis        identity.js: position ⇄ stable id (ids are never reused)
├── cells   Map<key, Cell>   key = rowId * 65536 + colId
│     Cell = { raw: string|null, f: Formula|null, v: value }
│     Formula = { tpl, refs }  tpl is shared (pieces + AST), refs are bound to ids
├── styles  Map<key, Style>  only non-default styles; Style is a frozen full object
├── colWidths Map<colId, px>, rowHeights Map<rowId, px>
├── view    { frozenRows, frozenCols, filters: Map<colId, FilterSpec>, sort: SortState|null }
├── dependents Map<key, Set<key>> + rangeFormulas Set<key>
└── undoStack / redoStack: transactions of invertible ops
```

- **Row and column identity.** Every row and column has an id that never changes. A position is simply where that id currently sits in the axis order. Cells, styles, sizes and formula references are all keyed by ids. So:
  - inserting or deleting a row only splices the id order;
  - styles and sizes move with their rows and columns at no cost;
  - an inserted column gets a new id, so it has the default width while the old D keeps 300 px;
  - a formula's text is rendered from the current positions of the ids it refers to. After inserting a row above row 10, `=$G$2*H32` renders as `=$G$2*H33` without being rewritten. A reference to a deleted row renders `#REF!`, and undo brings the id back.
- **Formulas are parsed once.** `parseFormula` produces a template: the source split around its references, plus an AST whose reference nodes point into `refs` by index. A filled cell shares the seed's template and gets a new `refs` array, shifted for relative parts and unchanged for `$` parts. Filling 100,000 formula cells therefore never re-parses text.
- **Sort moves rows by identity.** Sorting rewrites the id order of the sorted positions, nothing else, so:
  - formulas, styles and row heights go with their rows;
  - a single-cell reference follows its row (after sorting by Total, `K2 = J2/G2` belongs to ORD-1025 and shows 1080);
  - ranges are positional, so before permuting the engine records where each range endpoint sits and rebinds it to the id now at that position. `=SUM(J2:J32)` is unchanged.

  "Original order" is the id order saved when a sort cycle starts. That is the stable row identity the challenge asks for.
- **Filters are a view.** A filter spec per column id lives in `view.filters`. Hidden rows are computed from the specs and cached against the data version. A hidden row gets height 0 in the grid's prefix sums, which produces the gaps in the row numbers. Formulas never look at visibility.
- **The table.** Header-click sort and filters work on the table: the columns up to the last filled header cell in row 1, and the rows down to the last row with data in those columns. A trailing totals row (contract §3.1 / §4.2) is pinned: it is not sorted and not filtered. A stray value far away from the table therefore does not stretch the block.
- **Values.** A literal cell keeps its raw text for display, and its value is read leniently (`values.js` `toNum`): `$1,200.00` is 1200, `10%` is 0.1, and `2024-01-15` stays text. So `=G2*H2` works on the messy sample data, while the grid still shows `$1,200.00`.
- **Recalculation is incremental.** A change marks its transitive dependents dirty:
  - single-cell references are found through an exact reverse index;
  - formulas with ranges are found by a containment check;
  - only the dirty formulas are evaluated, precedents first, using an iterative DFS. A 20,000-long chain does not overflow the stack, and cycles evaluate to `#CYCLE!`.
- **The grid** (`src/grid`, no React) paints one canvas per frame:
  - `axisLayout.js` builds a prefix-sum array of row heights and another of column widths. Hidden rows have height 0. `indexAt(px)` is a binary search.
  - `geometry.js` turns scroll position and frozen panes into screen coordinates and hit tests.
  - `draw.js` paints the corner, frozen-row, frozen-column and body panes, each clipped. Only the visible rows and columns are painted, plus 2 overscan.
  
  The scroll container holds a spacer the size of the whole sheet, with the canvas `position: sticky` inside it. Scrolling repaints in `requestAnimationFrame` without a React render.
- **Incremental bookkeeping.** The used range and the table range are cached. Adding a cell can only grow them, so they are updated in place; a removal or a structural change drops the cache. `engine.layoutVersion` changes only when sizes, structure or row visibility can change, and the grid rebuilds its 100,000-entry prefix sums only then. Committing an edit with 130,000 filled cells therefore costs about 2–5 ms from Enter to the canvas showing the value.
- **No React state per cell.** React holds the engine's version number (`useSyncExternalStore`), the selection, the open editor and open menus. The canvas reads the engine directly.

## Engine API

Positions are 0-based. Every mutating method is one transaction, which is one undo step. A step that changes nothing creates no undo entry.

| Method | What it does | One undo reverts |
|---|---|---|
| `getCell(r, c)` | `{ raw, computed, error }` (unchanged contract) | – |
| `getText(r, c)` | what the grid shows before number formats | – |
| `getDisplay(r, c)` | what the grid paints: `getText`, plus the cell's `numberFormat` (display only, the stored value never changes) | – |
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
| `sortByColumn(c, selection?)` | header click: sorts the selection if it is a multi-row cell range, otherwise the table body with a totals row pinned. Cycles asc → desc → original and returns the new direction. Only visible rows move. | the sort (order, rebound ranges, sort state) |
| `sortRange(range, c, dir)` | sort an explicit block (`'asc' \| 'desc'`) | the sort |
| `getSortState()` | `{ col, dir, r1, r2, c1, c2 }` or null | – |
| `getTableRange()`, `totalsRowIndex()` | the table that sort and filters use, and its totals row (-1 if none) | – |
| `setFilter(c, { values, condition })`, `setFilter(c, null)` | values: allowed normalised values (`''` = blanks) or null for all; condition: `{ op: contains\|gt\|lt\|isEmpty\|notEmpty, value }` | the filter change |
| `clearFilters()` | remove every filter | all filters at once |
| `getFilter(c)`, `getFilterValues(c)` | current spec; distinct values grouped by normalised text, with first-seen label and count, (Blanks) last | – |
| `isRowHidden(r)`, `getFilterStatus()` | visibility, and `{ visible, total, active }` for the status line | – |
| `getTable()` | `{ header, rows }`: the used range as display text before number formats (row 1, then rows 2 to the last used row). This is the only data the AI code reads. | – |
| `getFormatSheet()` | read-only view for the format planner: `{ rowCount, colCount, getStyle, getText, frozenRows, getColWidth }` over the used range | – |
| `applyFormat({ styles, widths, frozenRows }, label)` | apply a planned format. Returns `false` and records nothing when nothing changes. | every style, width and freeze change of the plan |
| `layoutVersion` | changes when row/column geometry may have changed (sizes, structure, filters, freeze) | – |
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

### Sort and filter rules

- **Comparison** (`sortFilter.js`). Numbers come first, read leniently, so `$4,320.00` is a number. Then dates, in any of the three shapes, compared as dates. Then text, compared case-insensitively. Then errors, then blank cells, and finally completely empty rows. Formula-only rows count as empty, so the blank row of `sales.tsv` sorts last even with `K = J/G` filled through it. Descending reverses the non-blank tiers. Blanks always stay last. Ties keep their order: a stable sort with an index tie-break.
- **Filter values are grouped by `trim + lowercase`.** That's why "West", "West " and "west" are one checklist entry labelled "West", and a West filter shows all 8 such rows. That is the AI contract's normalisation, applied here too so the two features agree.
- Several column filters combine with AND. Within one column, the value list and the condition must both hold.
- **With a filter active, sort reorders only the visible rows**, among the visible positions. Hidden rows keep their place.
- **A selection narrower than the used range** can't move whole rows. Its cells are moved instead, and formulas shift as if copied. References from outside into that block do not follow; this is a documented limit.

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
| Sort (header click or the ⇅ icon) | the new order, including rebound ranges and the sort-cycle state |
| Apply or clear a column filter, or Clear all filters | that filter change (filters are part of history, so "undo twice" after filter + sort gives original order and no filter) |
| AI format → Apply | every style, column width and freeze change of that action. `NO_CHANGES` and `OUT_OF_RANGE` add no undo entry. |
| Insert into sheet (query result card) | the whole inserted block (header + rows) |
| Drag a column or row border; double-click a column border (auto-fit) | that one size change |
| Freeze row 1 / column A | the freeze change |
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
| Sort `sales-large.tsv` (2,990 data rows) by Date | **2.1 ms** median of 5 (first 3.6 ms) | Load "Sample 3k", click the ⇅ zone of the B header, read the status bar, undo, repeat. |
| Sort 10,000 rows < 300 ms | **6.8 ms** median of 5 (first 7.8 ms); full cycle desc 8.3 / original 0.5 / asc 7.4 ms | Paste 10,000 data rows (sales-large rows repeated) as tab-separated text, then the same click/undo loop. In Node: 30–42 ms cold (`sort.test.js`). |
| First paint < 100 ms | **21–25 ms** from navigation start (11–13 ms from app start), warm; the first cold load in a fresh browser was 98–152 ms | `performance.now()` at the first canvas paint, from navigation start, and minus a mark taken when `main.jsx` starts. 5 loads of `vite preview`. The 250 KB `sales-large` fixture is loaded on demand so it is not in the startup bundle. |
| Scrolling at 60 fps | **60 fps**: 120 frames in 2 s; frame interval p50 16.7 ms, p95 16.8 ms, max 16.8 ms; canvas paint 0.6 ms average, 1.8 ms worst | At row 95,000 with `sales-large` loaded and K2:K100000 filled (about 130,000 filled cells). `scrollTop += 37` every 8 ms while a rAF loop records frame timestamps. |
| Keystroke latency < 16 ms with 50,000+ filled cells | **0.5–8.5 ms** from keydown (`event.timeStamp`) to the next frame; 1 commit to open the editor, 0 per character, 2 on Enter | Same sheet. Typing `12345.67` into J95000. |
| Commit an edit | engine 0.4–0.6 ms; Enter → painted 1.6–5 ms | status bar "edit" and "edit → paint". Before the incremental used range and `layoutVersion` this was 13 ms. |
| Fill K2:K100000 with `=J2*2` | **83–94 ms** for 99,999 formula cells, including recalculation | status bar "fill". |
| Any golden plan over `sales-large.tsv` < 50 ms | **2.6–7.9 ms**, median 5.2 ms. That includes `engine.getTable()`, i.e. reading 2,990 × 10 cells. | All 20 golden prompts typed into the panel in mock mode. The card's "computed in" time is `performance.now()` around `executeQuery(plan, engine.getTable())`. Node: 0–2.4 ms excluding table extraction. |
| Format apply on `sales-large.tsv` < 300 ms | **29–30 ms** for f01 (3 runs; plan + apply; 29,920 cells; auto-fit measures every cell); 1.2 ms on `sales.tsv` | Card "Applied in": `performance.now()` around `planFormat` + `engine.applyFormat`. Node with a fake measurer: 64–110 ms. |
| Two-level group-by over 100,000 rows < 500 ms | **151–164 ms** (3 runs), including extracting the 100,000-row table | Paste 100,000 data rows, then ask "Break down sales by region and category" (q11: group by Region, Category; sum Total). Node, 100,021 generated rows, executor only: 43–58 ms. |

### Challenge 3: how the acceptance checks are run

- **Fill K2 = `=J2*2` to row 100,000.** Load "Sample 3k". Type `=J2*2` into K2. Type `K2:K100000` into the name box and press Enter. Press `Ctrl+D`. That fills 99,999 formula cells in one undo step.
- **Row 95,000.** Type `J95000` in the name box, then type a value and press Enter. The status bar shows the React commit count (app-shell commits, counted in an effect), the engine time of the edit, "edit → paint" and canvas frame times. The devtools Performance panel shows the same: typing creates no React commit, because the cell editor and formula bar are uncontrolled inputs mirrored through refs. Starting the edit is 1 commit and Enter is 2.
- **Freeze, resize, insert.** "❄ Row 1" freezes row 1. Drag D's header border to 300 px. Select column D and click "+ Col". The new D has the default 100 px and the old D, now E, keeps 300 px, because widths are keyed by column id. `structure.test.js` covers the same.

## AI

**Principle: the model translates, the engine computes.** Every number on a result card comes from `executeQuery` (`src/ai/queryExecutor.js`) run over `engine.getTable()`. The model's JSON is only a plan.

### Modules (all pure, no React)

| File | Role |
|---|---|
| `ai/provider.js` | Provider interface plus the http provider. It is the only file that knows wire formats: Anthropic Messages when the endpoint host is `anthropic.com`, OpenAI-compatible chat completions otherwise. Plain `fetch`. |
| `ai/mockProvider.js` | Unchanged starter mock; answers the golden prompts. |
| `ai/prompt.js` | System prompt: the task, the three JSON schemas, the rules, and the sheet context. |
| `ai/runRequest.js` | One round trip: prompt → `provider.complete` → `parseModelResponse`. The UI only sees `{ ok, action }` or `{ ok:false, error, detail }`. |
| `ai/extractJson.js` | Finds the first top-level JSON object in prose or code fences, with a string-aware brace matcher. |
| `ai/validate.js` | Hand-written JSON-Schema subset (`type`, `const`, `enum`, `required`, `properties`, `additionalProperties:false`, `items`, `minimum`, `maximum`, `pattern`). `validateAction` gates on `type` first. |
| `ai/queryExecutor.js` | AI_CONTRACT §3, exactly. |
| `ai/context.js` | Builds the sheet context (below). |
| `ai/describe.js` | Plain-words description of a plan, and the format preview. |

### Context sent to the model (exact shape, for `sales.tsv` with C2:C10 selected)

It goes in the system prompt. The `user` turn is the user's words only, because the mock matches the prompt verbatim; with a live model the effect is the same. History is the last 6 user/assistant turns. Rows: header plus five sample rows, never the data.

```json
{"range":"A1:J33","rowCount":30,
 "columns":[{"name":"Order ID","index":0,"type":"id","examples":["ORD-1001","ORD-1002","ORD-1003"]},
            {"name":"Date","index":1,"type":"date","examples":["2024-01-03","2024-01-05","1/8/2024"]},
            {"name":"Region","index":2,"type":"text","examples":["North","West","East"]},
            "… Sales Rep, Product, Category: text …",
            {"name":"Units","index":6,"type":"number","examples":["4","12","6"]},
            {"name":"Unit Price","index":7,"type":"currency","examples":["$1,200.00","$189.50","$320.00"]},
            {"name":"Discount","index":8,"type":"percent","examples":["10%","5%","15%"]},
            {"name":"Total","index":9,"type":"currency","examples":["$4,320.00","$2,160.30","$1,920.00"]}],
 "sampleRows":[["ORD-1001","2024-01-03","North","Aarav Shah","Laptop Pro","Electronics","4","$1,200.00","10%","$4,320.00"], "… 4 more …"],
 "selection":"C2:C10","hasTotalsRow":true}
```

`rowCount` counts data rows, excluding blank rows and the totals row. Column types are inferred from the body:
- **id**: an id-like header, or unique `ABC-123` values;
- **date**: at least 80% parse as dates;
- **currency** / **percent**: at least 80% numeric and at least half carry `$` / `%`;
- **number**: at least 80% numeric;
- **text**: anything else.

### Parsing, validation, failures

| Failure | What the user sees | Sheet |
|---|---|---|
| Network / auth / rate limit / other HTTP / empty reply | Red card "The AI provider failed" with `PROVIDER_ERROR` and the provider code: `PROVIDER_NETWORK`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT` (with retry-after), `PROVIDER_HTTP` (status + body snippet), `PROVIDER_EMPTY`. Missing configuration gives `PROVIDER_CONFIG`. Never swallowed. | unchanged |
| No JSON object / unparseable | `INVALID_RESPONSE` with the parse error; "Show model output" reveals the raw text | unchanged |
| Valid JSON, schema fails | `INVALID_RESPONSE` listing every failing path, e.g. `$.limit: must be >= 1` | unchanged |
| Action type not `query` / `format_sheet` / `clarify` (e.g. `mutation`) | `READ_ONLY` refusal | unchanged |
| Unknown filter op or aggregate | `UNKNOWN_OP` / `UNKNOWN_FN` | unchanged |
| Unknown column | "Which column did you mean?" with the offending name and the real headers. Nothing is guessed. | unchanged |
| `clarify` | The model's question is shown | unchanged |

`limit` is clamped to 500 in the executor, whatever the plan says. **Re-run** executes the stored plan again over the current sheet without calling the model. **Insert into sheet** writes header plus rows at the chosen cell (default: two columns right of the used range) in one undo step.

### Formatting (`format_sheet`)

- **Planning** (`ai/formatPlan.js`, pure) follows AI_CONTRACT §4:
  - row 1 is the header, and the body runs to the last used row;
  - the order is clear → body → columns → totals (only if the last row looks like a totals row) → header last;
  - the header never gets a `numberFormat`;
  - column indices outside the used range are ignored, and widths outside 30–600 are ignored;
  - `freezeRows` ≥ used rows is `OUT_OF_RANGE`, and nothing else in the action is applied;
  - auto-fit runs last and measures the formatted text with the canvas font (`grid/draw.js` `measureText`).

  The plan is a diff of full styles against the current ones, so an action that changes nothing is `NO_CHANGES`.
- **Applying** is `engine.applyFormat(plan)`: one transaction of style, size and view ops.
- **The card** shows the description (for example "header: bold, grey, centred; 4 columns: right-aligned, number formats; freeze 1 row; totals row: bold; auto-fit columns") and a dry-run summary ("Will change 144 cell styles, 10 column widths, freeze 1 row"). Apply re-plans against the current sheet, so an edit between preview and Apply is respected. Discard does nothing.
- **Number formats** (`engine/numberFormat.js`):

  | Format | Display |
  |---|---|
  | `number` | `1,200.00` |
  | `currency` | `$1,200.00` |
  | `percent` | `0.1` and `10%` both show `10%` |
  | `date` | any of the three shapes shows as `2024-01-15` |

  Non-numeric text such as `n/a` is shown unchanged. The toolbar's format picker uses the same style property.
- **Styles follow structure.** They are keyed by cell identity, so they move with insert/delete/sort, and undo restores them (`formatGolden.test.js`, "styles follow structure").

### Golden set vs. contract

- All 20 query cases match: columns exact, numbers within 0.01, order where the plan sorts, `rowsPreview`, `rowCount`, `truncated` and error codes.
- All 10 format cases pass through the engine, with one erratum. **f03** says `J22` displays `""`, but row 19 of `sales.tsv` is blank, so J22 is ORD-1020 (`$3,344.00`) and the blank Total is **J23** (ORD-1021). The test checks the intent ("blank stays blank") on J23.
- **f04 and f06 on a sheet with no formatting** are `NO_CHANGES` with no undo entry, per rule 7. Each is also tested after a prior action: freeze then unfreeze, and f01 then f06, where each is one undo step.
- **f08 on `sales-large.tsv`** (freeze 50 of 2,992 rows) is valid and applies; it is `OUT_OF_RANGE` only on the 33-row sheet.
- **Judgement calls:**
  - **Descending sort** negates the whole comparator, so non-numbers come before numbers in a descending row result. The contract's "numbers before non-numbers" is read as the ascending order. No golden case depends on this.
  - **A sort on a row result** may name any source column.
  - **`groupBy` with no aggregates** returns the distinct groups.
  - **Aggregates are rounded to 2 decimals before sorting**, so the order matches what is shown.

## Trade-offs and what you would do next

- **The API key is in the browser.** `VITE_*` variables are compiled into the bundle, so the http provider is for local use. Next step: a small `server/` proxy holding the key, which the provider would call instead; nothing else would change.
- **Queries run on the main thread.** About 160 ms for 100,000 rows: noticeable, but the panel stays usable. For bigger sheets, run `executeQuery` in a Web Worker over a transferred table.
- **Undo history is capped at 100 steps** and stores before/after records. A 100,000-cell fill keeps 100,000 small records alive until it falls off the stack.

- **Range formulas** are found by a containment scan over all range formulas for each changed cell. That's fine for tens of thousands of range formulas, but a column of 100,000 cumulative `SUM`s would need an interval index per column.
- **Filters re-evaluate on every data change** while active. Rows appear and disappear as you edit. Some spreadsheets only re-apply on request.
- **Formula language:** `+ - * / ^ &`, unary minus, parentheses, strings, and `SUM AVERAGE/AVG MIN MAX COUNT ABS ROUND`. There are no comparison operators and no `IF`.

## Use of AI tools

Claude Code was used for design discussion, code, tests, and a puppeteer script that runs the acceptance steps against the production build.
