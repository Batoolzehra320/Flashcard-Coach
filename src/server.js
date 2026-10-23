import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runAgent } from './agent.js';

const PORT = process.env.PORT || 3000;
const ROOMS = ['living', 'bedroom', 'kitchen'];
// Shared home state (persists across MCP sessions while the process runs)
const home = {
  lights: Object.fromEntries(ROOMS.map((r) => [r, { on: false, brightness: 100 }])),
  temp: 22, list: [], timers: [], nowPlaying: null,
};
const ok = (t) => ({ content: [{ type: 'text', text: t }] });

function buildServer() {
  const s = new McpServer({ name: 'alexa-home', version: '1.0.0' });

  s.registerTool('set_light', {
    description: 'Turn a room light on/off or set its brightness (1-100).',
    inputSchema: { room: z.enum(ROOMS).default('living'), on: z.boolean().optional(), brightness: z.number().min(1).max(100).optional() },
  }, async ({ room = 'living', on = true, brightness }) => {
    const l = home.lights[room];
    if (brightness != null) { l.brightness = brightness; l.on = true; } else l.on = on;
    return ok(`${room} light is ${l.on ? 'on at ' + l.brightness + '%' : 'off'}`);
  });

  s.registerTool('set_thermostat', {
    description: 'Set the target temperature in Celsius (16-30).',
    inputSchema: { temp: z.number() },
  }, async ({ temp }) => { home.temp = Math.min(30, Math.max(16, temp)); return ok(`thermostat set to ${home.temp} C`); });

  s.registerTool('add_item', {
    description: 'Add one item to the shopping list.', inputSchema: { item: z.string().min(1) },
  }, async ({ item }) => { home.list.push(item); return ok(`added ${item}`); });

  s.registerTool('list_items', { description: 'Read the shopping list.', inputSchema: {} },
    async () => ok(home.list.length ? 'your list: ' + home.list.join(', ') : 'your list is empty'));

  s.registerTool('start_timer', {
    description: 'Start a countdown timer.', inputSchema: { minutes: z.number().positive(), label: z.string().default('Kitchen') },
  }, async ({ minutes, label = 'Kitchen' }) => {
    home.timers.push({ label, endsAt: Date.now() + minutes * 60000 });
    return ok(`${label} timer set for ${minutes} min`);
  });

  s.registerTool('play_music', {
    description: 'Play music matching a query.', inputSchema: { query: z.string() },
  }, async ({ query }) => { home.nowPlaying = query; return ok(`playing ${query}`); });

  s.registerTool('get_state', { description: 'Return the full home state as JSON.', inputSchema: {} },
    async () => ok(JSON.stringify(home)));

  // Agent Skills exposed as MCP resources: metadata is listed, full body read on demand
  for (const d of readdirSync('skills')) {
    const text = readFileSync(`skills/${d}/SKILL.md`, 'utf8');
    const description = /description:\s*(.+)/.exec(text)?.[1] ?? d;
    s.registerResource(`skill-${d}`, `skill://${d}`, { mimeType: 'text/markdown', description },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }));
  }
  return s;
}

const app = express();
app.use(cors({ origin: true, exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'] }));
app.use(express.json());
app.use(express.static('public'));

const transports = {}; // sessionId -> transport

app.post('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  let transport = sid && transports[sid];
  if (!transport && !sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await buildServer().connect(transport);
  }
  if (!transport) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
  await transport.handleRequest(req, res, req.body);
});

const session = async (req, res) => {
  const t = transports[req.headers['mcp-session-id']];
  if (!t) return res.status(400).send('Invalid or missing session ID');
  await t.handleRequest(req, res);
};
app.get('/mcp', session);    // SSE stream for server-initiated messages
app.delete('/mcp', session); // explicit session termination

// LLM agent (Amazon Bedrock) that discovers tools + skills over MCP
app.post('/agent', async (req, res) => {
  try { res.json(await runAgent(req.body.prompt, `http://127.0.0.1:${PORT}/mcp`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Bind to localhost only (MCP transport guidance: protect against DNS rebinding)
app.listen(PORT, '127.0.0.1', () => console.log(`Alexa+ MCP server: http://127.0.0.1:${PORT}/mcp`));
