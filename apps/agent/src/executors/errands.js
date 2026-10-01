const { BaseExecutor } = require('./base');

const ERRAND_TOOLS = new Set(['startErrand', 'answerErrand', 'listErrands']);

/**
 * The errand tools (services/errands.js). Only the owner starts an errand,
 * from his own chat. He answers one from his chat, or by approving the card
 * the errand sent him.
 */
class ErrandsExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        if (!ERRAND_TOOLS.has(name)) return null;
        const services = this.getServices(callServices);
        const errands = services.agent?.errands;
        if (!errands) return { success: false, error: 'Errands are not available.' };
        const a = args && typeof args === 'object' ? args : {};
        const approved = context?.approved === true;
        const ownerTyped = context?.ownerTyped === true;

        switch (name) {
            case 'startErrand':
                // A job, a watcher, a sub-agent or a contact's chat never starts one,
                // not even with an approval card.
                if (!ownerTyped) return { success: false, error: 'An errand starts only from the owner\'s own chat.' };
                // A run that read someone else's text marks the request it writes.
                // runId: the first-message card belongs to this run, so its own reply after it leaves "sí" for it.
                // approvalId: the card he approved; a gate card keeps the line he typed.
                return errands.start(a, {
                    approved,
                    approvalId: context?.message?.metadata?.approvalId || null,
                    originMessage: context?.message || null,
                    taint: context?.untrustedTaint || [],
                    runId: context?.approvalRunId || null
                });
            case 'answerErrand':
                // taint: his words for say were written by a run that read someone else's text.
                // runId: a card this step raises belongs to this run.
                // originMessage: his typed words in it go to the message check.
                return errands.answer(a, {
                    byOwner: ownerTyped,
                    approved,
                    approvalId: context?.message?.metadata?.approvalId || null,
                    taint: context?.untrustedTaint || [],
                    runId: context?.approvalRunId || null,
                    originMessage: context?.message || null
                });
            case 'listErrands':
                return { success: true, errands: errands.list({ all: a.all === true }) };
            default:
                return null;
        }
    }
}

module.exports = { ErrandsExecutor, ERRAND_TOOLS };
