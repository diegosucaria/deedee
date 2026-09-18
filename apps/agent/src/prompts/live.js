// System prompt for the Gemini Live voice page (/live). It reuses the chat
// prompt's identity, constitution, language rules and communication style from
// prompts/system.js and adds the owner's facts. The coding prompt and the tool
// protocols stay out: a voice call has no room for them and the model gets the
// tool list in the same setup message anyway.
const {
    IDENTITY,
    CONSTITUTION,
    LANGUAGE_MATCHING_RULES,
    FACTS_HEADER,
    FACTS_RECALL_RULE,
    formatCommunicationStyle
} = require('./system');

/** About 1,500 tokens at four characters per token. */
const MAX_FACTS_CHARS = 6000;
/** About 3,000 tokens. The setup message also carries the tool declarations. */
const MAX_INSTRUCTION_CHARS = 12000;
/** The owner's own style block, which has no other limit. */
const MAX_STYLE_CHARS = 2000;

/** Cut text to maxChars on a line boundary, so no line is left half printed. */
function cutToLines(text, maxChars) {
    const whole = String(text || '');
    if (whole.length <= maxChars) return whole;
    const kept = [];
    let size = 0;
    for (const line of whole.split('\n')) {
        if (size + line.length + 1 > maxChars) break;
        kept.push(line);
        size += line.length + 1;
    }
    return kept.join('\n');
}

/** Rough token count at four characters per token, as the agent logs elsewhere. */
function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}

/** Drop the 12-space indentation the shared pieces carry for the chat prompt. */
function dedent(text) {
    return (text || '').split('\n').map(line => line.trimStart()).join('\n');
}

/**
 * Cut a "- key: value" facts block (db.getFactsFormatted) to maxChars on a line
 * boundary and say how many lines were left out.
 */
function compactFacts(formatted, maxChars = MAX_FACTS_CHARS) {
    const lines = (formatted || '').split('\n').filter(line => line.trim());
    const kept = [];
    let size = 0;
    for (const line of lines) {
        if (size + line.length + 1 > maxChars) break;
        kept.push(line);
        size += line.length + 1;
    }
    let hidden = lines.length - kept.length;
    if (hidden === 0) return { text: kept.join('\n'), shown: kept.length, hidden };

    // The note about hidden lines counts against the cap too.
    const note = n => `(${n} more facts not shown. Ask the owner if one is missing.)`;
    while (kept.length > 0 && size + note(hidden).length > maxChars) {
        size -= kept.pop().length + 1;
        hidden++;
    }
    return { text: [...kept, note(hidden)].join('\n'), shown: kept.length, hidden };
}

/**
 * Build the Live system instruction.
 * @returns {{ text: string, stats: object }} the prompt and its size figures for the log.
 */
function getLiveSystemInstruction({
    facts = '',
    factsPreCapped = false,
    factsShown = null,
    factsHidden = null,
    communicationStyle = '',
    ownerName = '',
    dateString = ''
} = {}) {
    const owner = ownerName ? ` Your owner's name is ${ownerName}.` : '';
    // The owner writes his own style, so it is the one piece with no natural
    // size. Cutting it here keeps everything else inside the cap.
    const style = cutToLines(dedent(formatCommunicationStyle(communicationStyle)).trim(), MAX_STYLE_CHARS);

    const fixed = [
        `${IDENTITY} You are on a live voice call with your owner through the Deedee web app.${owner}`,
        dedent(CONSTITUTION),
        dateString ? `CURRENT_TIME: ${dateString}` : '',
        `LANGUAGE PROTOCOL (CRITICAL - HIGHEST PRIORITY - NON-NEGOTIABLE):
${dedent(LANGUAGE_MATCHING_RULES)}
3. **Spoken**: Speak the language the user speaks. If they switch, switch with them.`,
        `VOICE CALL RULES:
1. Keep replies short: one or two sentences, then stop and listen. No lists, no markdown, no URLs read aloud.
2. Use your tools for anything about the owner's home, devices, messages, calendar, notes or the web. Say in a few words what you are doing, wait for the result, then answer from it.
3. Before an action that sends a message, spends money, or deletes or changes data, say what you will do and wait for a yes.
4. If a tool fails, say so in one sentence and offer the next step. Never invent a result.
5. If you did not understand, ask a short question.`
    ].filter(Boolean);

    // The facts are the only part that grows with his memory, so they take
    // what is left rather than push the rule below them off the end. Slicing
    // the whole instruction used to drop the recall rule and his style.
    const wrapper = `${FACTS_HEADER}\n\n${FACTS_RECALL_RULE}`;
    const spent = [...fixed, wrapper, style].filter(Boolean).join('\n\n').length;
    const room = Math.max(0, Math.min(MAX_FACTS_CHARS, MAX_INSTRUCTION_CHARS - spent));
    // An index arrives already inside its own budget and already counts what
    // it left out; a raw dump needs cutting and counting here.
    let compact;
    if (factsPreCapped) {
        const text = cutToLines(facts, room);
        compact = { text, shown: factsShown, hidden: factsHidden };
        // Trimming a block that already counted itself would leave the figures
        // claiming facts the model cannot see.
        if (text.length < facts.length && Number.isFinite(factsShown)) {
            const kept = text.split('\n').filter(l => l.startsWith('- ')).length;
            compact.hidden = (Number(factsHidden) || 0) + (factsShown - kept);
            compact.shown = kept;
        }
    } else {
        compact = compactFacts(facts, room);
    }

    const sections = [
        ...fixed,
        `${FACTS_HEADER}
${compact.text || 'Nothing stored yet.'}
${FACTS_RECALL_RULE}`,
        style
    ].filter(Boolean);

    let text = sections.join('\n\n');
    // A last resort that drops whole sections, never part of a line: the style
    // first, then the facts. Everything above them is what makes the call work.
    const dropped = [];
    for (let i = sections.length - 1; text.length > MAX_INSTRUCTION_CHARS && i > fixed.length - 1; i--) {
        dropped.push(i === sections.length - 1 && style ? 'communication_style' : 'facts');
        sections.splice(i, 1);
        text = sections.join('\n\n');
    }

    return {
        text,
        stats: {
            chars: text.length,
            approxTokens: approxTokens(text),
            factsChars: compact.text.length,
            factsShown: compact.shown,
            factsHidden: compact.hidden,
            truncated: dropped.length > 0 || compact.text.length < facts.length,
            dropped
        }
    };
}

module.exports = { getLiveSystemInstruction, compactFacts, cutToLines, approxTokens, MAX_FACTS_CHARS, MAX_INSTRUCTION_CHARS };
