# Spec 018: Date Awareness

## Goal
The Agent needs to be aware of the current system date and time to answer questions like "What day is it?" or "Check my calendar for tomorrow".

## Requirements

1. **System Prompt Injection**:
   - The Agent's system instruction MUST include the current local date and time.
   - Format: `CURRENT_TIME: YYYY-MM-DD HH:mm:ss (Timezone)`
   - This ensures every model interaction has the correct time context.

2. **Source of Truth**:
   - Use the Javascript `Date` object from the running Node.js process (which runs on the Pi/Server).

## Verification
- Unit Test: Instantiate the Agent (mocking the LLM) and verify the `systemInstruction` contains the current date.
