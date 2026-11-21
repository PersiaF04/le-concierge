#!/usr/bin/env node
// Le Concierge MCP server (stdio). Read-only tools over the concierge API.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, DEFAULT_API_URL, callTool, createApi } from './src/tools.js';

const get = createApi({ baseUrl: process.env.LE_CONCIERGE_API_URL || DEFAULT_API_URL });
const server = new Server({ name: 'le-concierge', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(get, req.params.name, req.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());
