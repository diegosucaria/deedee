const { MCPManager } = require('./src/mcp-manager');
const path = require('path');

async function main() {
    console.log('Checking MCP Tools...');
    const mcp = new MCPManager();
    await mcp.init();
    const tools = await mcp.getTools();
    console.log('Tools Found:', tools.map(t => t.name));
    await mcp.close();
}

main().catch(console.error);
