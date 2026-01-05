
/**
 * Extracts function calls from a Gemini response.
 * @param {object} response - The Gemini response object.
 * @returns {Array} List of function calls.
 */
function getFunctionCalls(response) {
    const candidates = response.candidates;
    if (!candidates || !candidates.length) return [];

    const content = candidates[0].content;
    if (!content || !content.parts) return [];

    return content.parts
        .filter(part => part.functionCall)
        .map(part => part.functionCall);
}

/**
 * Generates a "thinking" message based on the tools being called.
 * @param {Array} calls - List of function calls.
 * @returns {string} The thinking text.
 */
function getThinkingMessage(calls) {
    if (!calls || calls.length === 0) return 'Thinking...';

    const name = calls[0].name;

    switch (name) {
        case 'readFile': return 'Reading file...';
        case 'writeFile': return 'Writing to file...';
        case 'listDirectory': return 'Checking directory contents...';
        case 'runShellCommand': return 'Running system command...';
        case 'pullLatestChanges': return 'Pulling latest code...';
        case 'commitAndPush': return 'Committing changes...';
        case 'rollbackLastChange': return 'Rolling back changes...';
        case 'listEvents': return 'Checking calendar...';
        case 'sendEmail': return 'Sending email...';
        case 'logJournal': return 'Writing to journal...';
        case 'rememberFact':
        case 'getFact': return 'Accessing memory...';
        case 'addGoal':
        case 'completeGoal': return 'Updating goals...';
        case 'replyWithAudio': return null; // Suppress display for audio generation
        default: return `Executing ${name}...`;
    }
}

module.exports = { getFunctionCalls, getThinkingMessage };
