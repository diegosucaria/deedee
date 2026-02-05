---
name: nano-pdf
description: Edit PDFs with natural-language instructions using the nano-pdf CLI.
user-invocable: true
metadata:
  emoji: 📄
  requires:
    bins: ["nano-pdf"]
---

# nano-pdf

Use `run_shell_command` with `nano-pdf` to apply edits to a specific page in a PDF using a natural-language instruction.

## Quick start

```bash
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"
```

## Usage
1. Provide the input PDF path.
2. Provide the page number (try 1-based first).
3. Provide the instruction string.
