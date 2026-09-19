// The outcome names live in the agent (the history filter accepts only these)
// and in the web (labels and chart groups). A name one side lacks shows as a
// raw id, drops out of the filters, or earns a 400. They must match.
const { OUTCOMES: AGENT_OUTCOMES } = require('../../agent/src/routes/guardian.js');
const { OUTCOMES: WEB_OUTCOMES } = require('../src/lib/guardian.js');

test('the agent and the web know the same outcomes', () => {
    expect([...WEB_OUTCOMES.map(o => o.id)].sort()).toEqual([...AGENT_OUTCOMES].sort());
});
