/**
 * The attachment analysis and the DJ crate. A screenshot of a shop cart sent
 * to chat with "do I own these?" became eight records in the crate: the
 * analysis ran in the background, called the vinyl ingest, and the model
 * then "found" them. Nothing the owner did not ask for reaches the crate.
 */
const { AnalysisService } = require('../src/services/analysis-service');

const reply = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const image = { inlineData: { mimeType: 'image/png', data: 'AAAA' } };

function fakeAgent(analysis) {
    return {
        db: null,
        vaults: {
            listVaults: jest.fn().mockResolvedValue([{ id: 'health' }, { id: 'finance' }, { id: 'dj_history' }]),
            updateVaultPage: jest.fn().mockResolvedValue(),
        },
        client: { models: { generateContent: jest.fn().mockResolvedValue(reply(analysis)) } },
        djService: { ingestVinylFromBase64: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
    };
}

describe('attachment analysis and the DJ crate', () => {
    afterEach(() => { delete process.env.DJ_AUTO_INGEST; });

    test('a record photo in chat is not added to the crate by the analysis', async () => {
        const agent = fakeAgent({ vaultId: 'dj_history', summary: 'a list of records', suggestedMemories: [] });
        await new AnalysisService(agent).analyzeAttachment('chat-1', image, 'none');
        expect(agent.client.models.generateContent).toHaveBeenCalledTimes(1);
        expect(agent.djService.ingestVinylFromBase64).not.toHaveBeenCalled();
        // No note either: the DJ vault feeds the recommendations, and a cart is not history.
        expect(agent.vaults.updateVaultPage).not.toHaveBeenCalled();
    });

    test('DJ_AUTO_INGEST=1 brings the old auto-add back', async () => {
        process.env.DJ_AUTO_INGEST = '1';
        const agent = fakeAgent({ vaultId: 'dj_history', summary: 'a record', suggestedMemories: [] });
        await new AnalysisService(agent).analyzeAttachment('chat-1', image, 'none');
        expect(agent.djService.ingestVinylFromBase64).toHaveBeenCalledWith('AAAA', 'image/png');
    });

    test('a finance file still gets its vault note', async () => {
        const agent = fakeAgent({ vaultId: 'finance', summary: 'an invoice', suggestedMemories: [] });
        await new AnalysisService(agent).analyzeAttachment('chat-1', image, 'none');
        expect(agent.vaults.updateVaultPage).toHaveBeenCalledTimes(1);
        expect(agent.vaults.updateVaultPage.mock.calls[0][0]).toBe('finance');
        expect(agent.djService.ingestVinylFromBase64).not.toHaveBeenCalled();
    });
});
