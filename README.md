# Alexa+ MCP: skills-driven smart-home agent

A self-hosted **MCP server** (spec **2025-11-25**, **Streamable HTTP**) with **Agent Skills** (`skills/*/SKILL.md`, exposed as MCP resources)
and a web app that simulates the Alexa+ experience. An optional **Amazon Bedrock** agent discovers tools and skills over MCP and calls them.

## Run
```bash
npm install
npm start                      # http://127.0.0.1:3000  (MCP endpoint: /mcp)
```
Optional LLM agent (AWS Builder mini challenge):
```bash
export AWS_REGION=us-east-1 BEDROCK_MODEL_ID=<model or inference-profile id you have access to>
npm start
```
Without these variables the web app falls back to a rule-based planner (still calling real MCP tools).

## Test the transport
```bash
curl -i -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```
Check that `result.protocolVersion` is `2025-11-25` and an `Mcp-Session-Id` header is returned. If it is older, update `@modelcontextprotocol/sdk`.
Or run `npx @modelcontextprotocol/inspector` and connect to `http://127.0.0.1:3000/mcp`.

## Layout
`src/server.js` MCP server and routes · `src/agent.js` Bedrock agent loop · `skills/` Agent Skills · `public/index.html` web client
