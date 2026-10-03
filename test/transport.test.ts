import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverPath = resolve('dist/src/server.js');

test('MCP tools work over stdio', async () => {
  const client = new Client({ name: 'diagram-eval-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['evaluate_diagram', 'list_diagram_types']);
    assert.ok(list.tools.find(tool => tool.name === 'evaluate_diagram')?.outputSchema);
    const result = await client.callTool({ name: 'evaluate_diagram', arguments: {
      diagram_type: 'c4-context',
      diagram_xml: '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
    } });
    const structured = result.structuredContent as {
      diagram_type: string;
      valid: boolean;
      findings: { severity: string; code: string; message: string; cell_ids: string[]; elements: unknown[] }[];
    };
    assert.equal(structured.diagram_type, 'c4-context');
    assert.equal(structured.valid, false);
    assert.deepEqual(structured.findings.map(item => item.code), ['MISSING_KEY', 'MISSING_TITLE_BLOCK']);
    assert.ok(structured.findings.every(item => item.severity === 'error' && item.message &&
      Array.isArray(item.cell_ids) && Array.isArray(item.elements)));
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), structured);
  } finally {
    await client.close();
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port.');
  const port = address.port;
  await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  return port;
}

test('MCP tools work over localhost Streamable HTTP', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath, '--http', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server did not start.')), 10000);
      child.stderr.on('data', data => {
        if (!String(data).includes('listening on')) return;
        clearTimeout(timer);
        resolveReady();
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`HTTP server exited with ${code}.`));
      });
    });
    const client = new Client({ name: 'diagram-eval-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'list_diagram_types' });
      const names = (result.structuredContent as { diagram_types: { diagram_type: string }[] }).diagram_types.map(type => type.diagram_type);
      assert.deepEqual(names, ['c4-container', 'c4-context']);
    } finally {
      await client.close();
    }
  } finally {
    child.kill();
  }
});
