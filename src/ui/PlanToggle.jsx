// "Show plan" toggle: the raw action JSON behind a result card.
export function PlanToggle({ m, update }) {
    return (
        <>
            <button type="button" className="ai-link" onClick={() => update({ showPlan: !m.showPlan })}>
                {m.showPlan ? 'Hide plan' : 'Show plan'}
            </button>
            {m.showPlan && <pre className="ai-plan">{JSON.stringify(m.action ?? null, null, 2)}</pre>}
        </>
    )
}
