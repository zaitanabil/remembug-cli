/**
 * Remembug MCP server (stdio).
 *
 * Claude Code launches this as a separate process via `~/.claude/mcp.json`
 * — it speaks the Model Context Protocol over stdin/stdout and reuses
 * the same SQLite store the daemon writes to. The server is stateless
 * past the SQLite connection.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LocalEmbedder, type EmbeddingProvider } from '../embeddings/index.js';
import { Store } from '../store/index.js';
import { FeedbackInputSchema, feedbackTool } from './tools/feedback.js';
import { GetInputSchema, getTool } from './tools/get.js';
import { SearchInputSchema, searchTool } from './tools/search.js';

export interface McpServerOptions {
  dbPath: string;
  embedder?: EmbeddingProvider;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const store = new Store({ path: options.dbPath });
  const embedder = options.embedder ?? new LocalEmbedder();

  const server = new Server(
    { name: 'remembug', version: '0.1.10' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'remembug.search',
        description:
          'Search the local Remembug knowledge base for entries matching a natural-language query. Use this BEFORE reasoning from scratch about a new error — there may already be a captured solution.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text query.' },
            project_path: {
              type: 'string',
              description: 'Absolute path to the active project; used to bias by stack.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['query'],
        },
      },
      {
        name: 'remembug.get',
        description: 'Fetch the full text of a single Remembug entry by id.',
        inputSchema: {
          type: 'object',
          properties: { entry_id: { type: 'string' } },
          required: ['entry_id'],
        },
      },
      {
        name: 'remembug.feedback',
        description:
          'Record whether a Remembug entry helped resolve the current problem. Increments the confirmation count when helpful=true.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string' },
            helpful: { type: 'boolean' },
            notes: { type: 'string' },
          },
          required: ['entry_id', 'helpful'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case 'remembug.search': {
          const input = SearchInputSchema.parse(args);
          const results = await searchTool(input, { store, embedder });
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }
        case 'remembug.get': {
          const input = GetInputSchema.parse(args);
          const entry = getTool(input, { store });
          return {
            content: [{ type: 'text', text: entry ? JSON.stringify(entry, null, 2) : 'not_found' }],
            isError: !entry,
          };
        }
        case 'remembug.feedback': {
          const input = FeedbackInputSchema.parse(args);
          const fb = feedbackTool(input, { store });
          return {
            content: [{ type: 'text', text: JSON.stringify(fb) }],
          };
        }
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (e) {
      // Don't surface internal exception text (zod/SQLite internals) to the
      // MCP client; log it locally for debugging instead.
      process.stderr.write(
        `[remembug-mcp] tool error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return {
        content: [{ type: 'text', text: 'internal error' }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
