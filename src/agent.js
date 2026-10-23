import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function runAgent(prompt, mcpUrl) {
  if (!process.env.BEDROCK_MODEL_ID) throw new Error('Set BEDROCK_MODEL_ID (and AWS credentials) to use the LLM agent');
  const client = new Client({ name: 'alexa-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  try {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const skillIndex = resources.map((r) => `- ${r.uri}: ${r.description}`).join('\n');
    const toolConfig = { tools: [
      ...tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })),
      { toolSpec: { name: 'load_skill', description: 'Load the full SKILL.md for a skill before using its tools.',
        inputSchema: { json: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] } } } },
    ] };
    const system = [{ text: `You are Alexa+, a concise voice assistant for a smart home. Available skills:\n${skillIndex}\nLoad a skill before using its tools. Reply in one or two short sentences.` }];
    const messages = [{ role: 'user', content: [{ text: prompt }] }];
    const trace = [];
    for (let i = 0; i < 6; i++) {
      const r = await bedrock.send(new ConverseCommand({ modelId: process.env.BEDROCK_MODEL_ID, system, messages, toolConfig }));
      const msg = r.output.message;
      messages.push(msg);
      const uses = msg.content.filter((c) => c.toolUse);
      if (!uses.length) return { reply: msg.content.map((c) => c.text || '').join(''), trace };
      const results = [];
      for (const { toolUse: u } of uses) {
        let out;
        try {
          if (u.name === 'load_skill') out = (await client.readResource({ uri: u.input.uri })).contents[0].text;
          else out = (await client.callTool({ name: u.name, arguments: u.input })).content.map((c) => c.text).join('');
        } catch (e) { out = 'Error: ' + e.message; }
        trace.push({ tool: u.name, input: u.input, output: out });
        results.push({ toolResult: { toolUseId: u.toolUseId, content: [{ text: out }] } });
      }
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'I stopped after too many steps.', trace };
  } finally { await client.close(); }
}
