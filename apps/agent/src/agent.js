const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');

class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.genAI = new GoogleGenerativeAI(config.googleApiKey);
    
    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source'); // Restrict to source dir by default, or /app
    
    // Define Tools for Gemini
    const tools = [
      {
        functionDeclarations: [
          // GSuite
          {
            name: "listEvents",
            description: "List calendar events for a time range",
            parameters: {
              type: "OBJECT",
              properties: {
                timeMin: { type: "STRING" },
                timeMax: { type: "STRING" },
                maxResults: { type: "NUMBER" }
              }
            }
          },
          {
            name: "sendEmail",
            description: "Send an email",
            parameters: {
              type: "OBJECT",
              properties: {
                to: { type: "STRING" },
                subject: { type: "STRING" },
                body: { type: "STRING" }
              },
              required: ["to", "subject", "body"]
            }
          },
          // Local System
          {
            name: "readFile",
            description: "Read a file from the local system",
            parameters: {
              type: "OBJECT",
              properties: { path: { type: "STRING" } },
              required: ["path"]
            }
          },
          {
            name: "writeFile",
            description: "Write content to a file",
            parameters: {
              type: "OBJECT",
              properties: { 
                path: { type: "STRING" },
                content: { type: "STRING" }
              },
              required: ["path", "content"]
            }
          },
          {
            name: "listDirectory",
            description: "List files in a directory",
            parameters: {
              type: "OBJECT",
              properties: { path: { type: "STRING" } },
              required: ["path"]
            }
          },
          {
            name: "runShellCommand",
            description: "Run a shell command (allowed: ls, grep, git, npm, etc)",
            parameters: {
              type: "OBJECT",
              properties: { command: { type: "STRING" } },
              required: ["command"]
            }
          }
        ]
      }
    ];

    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro', tools });
    this.chat = this.model.startChat();
    
    this.onMessage = this.onMessage.bind(this);
  }

  async start() {
    console.log('Agent starting...');
    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  async onMessage(message) {
    try {
      console.log(`Received: ${message.content}`);

      const result = await this.chat.sendMessage(message.content);
      const response = await result.response;
      
      const calls = response.functionCalls();
      if (calls && calls.length > 0) {
        const call = calls[0];
        console.log(`Function Call: ${call.name}`, call.args);
        
        let toolResult;
        // GSuite
        if (call.name === 'listEvents') toolResult = await this.gsuite.listEvents(call.args);
        else if (call.name === 'sendEmail') toolResult = await this.gsuite.sendEmail(call.args);
        // Local
        else if (call.name === 'readFile') toolResult = await this.local.readFile(call.args.path);
        else if (call.name === 'writeFile') toolResult = await this.local.writeFile(call.args.path, call.args.content);
        else if (call.name === 'listDirectory') toolResult = await this.local.listDirectory(call.args.path);
        else if (call.name === 'runShellCommand') toolResult = await this.local.runShellCommand(call.args.command);

        console.log('Tool Result:', toolResult);
        const nextResult = await this.chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          }
        ]);
        
        const finalResponse = createAssistantMessage(nextResult.response.text());
        finalResponse.metadata = { chatId: message.metadata?.chatId };
        await this.interface.send(finalResponse);

      } else {
        const text = response.text();
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId: message.metadata?.chatId };
        await this.interface.send(reply);
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
      const errReply = createAssistantMessage(`Error: ${error.message}`);
      errReply.metadata = { chatId: message.metadata?.chatId };
      await this.interface.send(errReply);
    }
  }
}

module.exports = { Agent };