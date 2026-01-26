#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdapterRegistry } from './core/registry.js';

const registry = new AdapterRegistry();

const server = new Server({
  name: "anydb-mcp",
  version: "1.0.0",
}, {
  capabilities: { tools: {} },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "db_query",
    description: "Выполняет запрос к любой БД. Сама определяет тип по URI.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string" },
        query: { type: "string" },
        collection: { type: "string" }
      },
      required: ["uri", "query"]
    }
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { uri, query, collection } = request.params.arguments;
  console.error(`[CallTool] URI: ${uri}, Query: ${query.substring(0, 50)}...`);
  try {
    const data = await registry.run(uri, query, { collection });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `DATABASE_ERROR: ${error.message}\nSUGGESTION: Check if your ${uri.split(':')[0]} syntax is correct.`
      }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);