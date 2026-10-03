import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { TypeRegistry } from './library.js';
import { evaluateDiagram } from './evaluate.js';

const registry = new TypeRegistry();
const evaluationOutputSchema = z.object({
  diagram_type: z.string(),
  valid: z.boolean(),
  summary: z.object({
    passed_checks: z.array(z.string()),
    error_count: z.number().int().nonnegative(),
    warning_count: z.number().int().nonnegative(),
  }),
  findings: z.array(z.object({
    severity: z.enum(['error', 'warning']),
    code: z.string(),
    message: z.string(),
    cell_ids: z.array(z.string()).describe('Deprecated; use elements for cell details.'),
    elements: z.array(z.object({
      cell_id: z.string(),
      kind: z.string(),
      name: z.string().optional(),
      type: z.string().optional(),
      parent_id: z.string().optional(),
      geometry: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional(),
      source_id: z.string().optional(),
      source_name: z.string().optional(),
      target_id: z.string().optional(),
      target_name: z.string().optional(),
    })),
    expected_library_entry: z.string().optional(),
    differences: z.array(z.object({
      property: z.string(),
      expected: z.string().optional(),
      actual: z.string().optional(),
      cell_id: z.string().optional(),
    })).optional(),
  })),
});

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'diagram-eval', version: '1.0.0' });
  server.registerTool('list_diagram_types', {
    description: 'List diagram types and their allowed library entries.',
  }, async () => {
    const result = { diagram_types: registry.list() };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool('evaluate_diagram', {
    description: 'Evaluate the first page of a draw.io diagram against a configured shape library and connection rules; warn when more pages exist.',
    inputSchema: z.object({
      diagram_type: z.string().min(1),
      diagram_xml: z.string().min(1),
    }),
    outputSchema: evaluationOutputSchema,
  }, async ({ diagram_type, diagram_xml }) => {
    const result = evaluateDiagram(registry, diagram_type, diagram_xml);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const http = args.includes('--http');
  if (!http) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const portIndex = args.indexOf('--port');
  const portText = portIndex >= 0 ? args[portIndex + 1] : process.env.PORT ?? '3000';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Use --http [--port 1..65535], or omit arguments for stdio.');
  }
  const handler = createMcpHandler(buildServer, { responseMode: 'json', maxRequestBodySize: 20 * 1024 * 1024 });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 20 * 1024 * 1024 });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const httpServer = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    void nodeHandler(request, response);
  });
  httpServer.listen(port, '127.0.0.1', () => {
    console.error(`diagram-eval listening on http://127.0.0.1:${port}/mcp`);
  });
  const close = async (): Promise<void> => {
    httpServer.close();
    await handler.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
