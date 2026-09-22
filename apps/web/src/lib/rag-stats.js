// The Knowledge Base card on /system/stats. It used to read
// `stats.rag.totalDocuments`, a field getStats() never returned, so the card
// always said 0 Docs. The field names here must match
// apps/agent/src/services/rag-service.js getStats().

/** "12 Docs" for the card's big number. */
export function knowledgeBaseValue(rag) {
    const documents = Number(rag?.documents) || 0;
    return `${documents} Docs`;
}

/** "480 chunks" under the number, or null when nothing is indexed. */
export function knowledgeBaseDetail(rag) {
    const chunks = Number(rag?.chunks) || 0;
    if (!chunks) return null;
    return `${chunks} chunks`;
}
