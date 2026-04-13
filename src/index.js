#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdapterRegistry, TimeoutError, DEFAULT_TIMEOUT } from './core/registry.js';

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
    description: "Executes a query against any database. Automatically detects type from URI.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "Connection string (e.g., postgres://user:pass@host:5432/db)" },
        query: { type: "string", description: "SQL query, MongoDB filter (JSON), or Redis command" },
        collection: { type: "string", description: "Required only for MongoDB" },
        timeout: { type: "number", description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}ms)` }
      },
      required: ["uri", "query"]
    }
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { uri, query, collection, timeout } = request.params.arguments;
  const timeoutStr = timeout ? ` ${timeout}ms` : ' default';
  console.error(`[CallTool] URI: ${uri}, Query: ${query.substring(0, 50)}..., Timeout:${timeoutStr}`);
  try {
    const options = { collection };
    if (timeout !== undefined) {
      options.timeout = timeout;
    }
    const data = await registry.run(uri, query, options);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    let errorMessage = error.message;
    let suggestion = '';

    // Specific handling for timeouts
    if (error instanceof TimeoutError) {
      suggestion = `Query exceeded ${timeout || DEFAULT_TIMEOUT}ms timeout. Try optimizing your query or increasing the timeout parameter.`;
    } else if (error.message.includes('timed out')) {
      suggestion = 'Connection or query timed out. Check if the database server is accessible.';
    } else {
      suggestion = `Check if your ${uri.split(':')[0]} syntax is correct.`;
    }

    return {
      content: [{
        type: "text",
        text: `DATABASE_ERROR: ${errorMessage}\nSUGGESTION: ${suggestion}`
      }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);