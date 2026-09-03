const crypto = require('crypto');
const { getDb } = require('./database');
const { searchHybrid, formatHybridContext } = require('./services/librarian');

function authorize(req, res, next) {
  const expected = process.env.MCP_BEARER_TOKEN || '';
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected) return res.status(503).json({ error: 'MCP_BEARER_TOKEN is not configured' });
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function normalizeTimestamp(value) {
  const d = value ? new Date(value) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().slice(0, 19).replace('T', ' ');
}

async function createServer() {
  const [{ McpServer }, { StreamableHTTPServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('zod')
  ]);

  const server = new McpServer(
    { name: 'yan-memory-constellations', version: '1.0.0' },
    { instructions: 'Source-backed memory for Lin Yan and Yan. Recall before relying on relationship history. Never invent missing history. Save only messages that actually occurred.' }
  );

  server.registerTool(
    'recall_memory',
    {
      description: 'Search source-backed long-term memories relevant to the current message.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit = 8 }) => {
      const memories = await searchHybrid(query, limit);
      const text = memories.length
        ? `【记忆库检索结果】\n${formatHybridContext(memories)}`
        : '记忆库中没有找到相关记忆。';
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'save_messages',
    {
      description: 'Save messages that actually occurred for later source-backed extraction.',
      inputSchema: {
        messages: z.array(z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1),
          timestamp: z.string().optional()
        })).min(1).max(100),
        chat_id: z.number().int().positive().optional()
      }
    },
    async ({ messages, chat_id = 1 }) => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, status)
        VALUES (?, ?, ?, ?, 0, 'text', 'sent')
      `);
      db.transaction((rows) => {
        for (const row of rows) {
          const sender = row.role === 'user' ? 'user' : 'ai';
          insert.run(chat_id, sender, row.content, normalizeTimestamp(row.timestamp));
        }
      })(messages);
      return { content: [{ type: 'text', text: `已保存 ${messages.length} 条真实对话消息。` }] };
    }
  );

  server.registerTool(
    'browse_constellations',
    {
      description: 'List active memory constellations and source-backed overviews.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const rows = getDb().prepare(`
        SELECT id, name, category, overview, current_status, fragment_count
        FROM entity_profiles
        WHERE status = 'active'
        ORDER BY fragment_count DESC, updated_at DESC
        LIMIT 100
      `).all();
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  return { server, StreamableHTTPServerTransport };
}

module.exports = function mountMemoryMcp(app) {
  app.post('/mcp', authorize, async (req, res) => {
    let transport;
    try {
      const { server, StreamableHTTPServerTransport } = await createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] request failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });

  app.get('/mcp', authorize, (_req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  app.delete('/mcp', authorize, (_req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });
};
