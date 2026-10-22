// Toolbar: formatting for the whole selection, undo/redo, structure,
// freeze panes, filters and the sample loaders.
const FILLS = [
    ['white', 'White'], ['#ffff99', 'Yellow'], ['#99ffcc', 'Green'], ['#ffcccc', 'Red'],
    ['#cce5ff', 'Blue'], ['#e0ccff', 'Purple'], ['#ffd9b3', 'Orange'], ['#f0f0f0', 'Gray'],
]
const SIZES = [8, 10, 11, 12, 13, 14, 16, 18, 20, 24]

export function Toolbar({ engine, style, onStyle, onUndo, onRedo, onInsertRow, onDeleteRow, onInsertColumn, onDeleteColumn,
    onClear, filterMode, onToggleFilters, onClearFilters, onLoadSmall, onLoadLarge, extra }) {
    const btn = (active) => `toolbar-btn ${active ? 'active' : ''}`
    return (
        <div className="toolbar" role="toolbar">
            <div className="toolbar-group">
                <button className="toolbar-btn" onClick={onUndo} disabled={!engine.canUndo()} title={`Undo ${engine.undoLabel() ?? ''} (Ctrl+Z)`}>↶</button>
                <button className="toolbar-btn" onClick={onRedo} disabled={!engine.canRedo()} title={`Redo ${engine.redoLabel() ?? ''} (Ctrl+Y)`}>↷</button>
            </div>
            <div className="toolbar-group">
                <button className={btn(style.bold) + ' bold-btn'} onClick={() => onStyle({ bold: !style.bold })} title="Bold (Ctrl+B)">B</button>
                <button className={btn(style.italic) + ' italic-btn'} onClick={() => onStyle({ italic: !style.italic })} title="Italic (Ctrl+I)">I</button>
                <button className={btn(style.underline) + ' underline-btn'} onClick={() => onStyle({ underline: !style.underline })} title="Underline (Ctrl+U)">U</button>
                <select className="toolbar-select" value={style.fontSize} onChange={e => onStyle({ fontSize: parseInt(e.target.value, 10) })} title="Font size">
                    {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>
            <div className="toolbar-group">
                {['left', 'center', 'right'].map(a => (
                    <button key={a} className={btn(style.align === a)} onClick={() => onStyle({ align: a })} title={`Align ${a}`}>
                        {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                    </button>
                ))}
            </div>
            <div className="toolbar-group">
                <input type="color" className="toolbar-color" value={style.color} onChange={e => onStyle({ color: e.target.value })} title="Text colour" />
                <select className="toolbar-select" value={style.bg} onChange={e => onStyle({ bg: e.target.value })} title="Fill colour">
                    {FILLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
            </div>
            <div className="toolbar-group">
                <button className="toolbar-btn" onClick={onInsertRow} title="Insert row above">+ Row</button>
                <button className="toolbar-btn" onClick={onDeleteRow} title="Delete row">− Row</button>
                <button className="toolbar-btn" onClick={onInsertColumn} title="Insert column left">+ Col</button>
                <button className="toolbar-btn" onClick={onDeleteColumn} title="Delete column">− Col</button>
                <button className="toolbar-btn danger" onClick={onClear} title="Clear selection (Delete)">✕ Clear</button>
            </div>
            <div className="toolbar-group">
                <button className={btn(filterMode)} onClick={onToggleFilters} title="Show filter buttons on the header row">⏷ Filter</button>
                <button className="toolbar-btn" onClick={onClearFilters} disabled={!engine.getFilterStatus().active} title="Clear all filters">Clear filters</button>
            </div>
            <div className="toolbar-group">
                <button className="toolbar-btn" onClick={onLoadSmall} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
                <button className="toolbar-btn" onClick={onLoadLarge} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
            </div>
            {extra}
        </div>
    )
}
