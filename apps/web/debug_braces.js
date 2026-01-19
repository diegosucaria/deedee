
const fs = require('fs');
const content = fs.readFileSync('/Users/diego/Projects/DeeDee/apps/web/src/app/chat/[id]/page.js', 'utf8');
const lines = content.split('\n');

let depth = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Remove strings/comments hack
    let cleaned = line.replace(/`.*?`/g, '').replace(/'(.*?)'/g, '').replace(/"(.*?)"/g, '').replace(/\/\/.*$/, '');

    // Count braces
    for (let char of cleaned) {
        if (char === '{') depth++;
        if (char === '}') depth--;
    }

    if (i > 690 && i < 710) {
        console.log(`Line ${i + 1}: Depth ${depth} | ${line.trim()}`);
    }
    if (depth <= 0 && i > 20) {
        console.log(`!!! DEPTH ${depth} AT LINE ${i + 1} !!!`);
    }
}
console.log(`Final Depth: ${depth}`);
