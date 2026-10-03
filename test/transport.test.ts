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
    const outputSchema = list.tools.find(tool => tool.name === 'evaluate_diagram')?.outputSchema;
    assert.ok(outputSchema);
    assert.ok((outputSchema as { required?: string[] }).required?.includes('evaluated_at'));
    const emptyModel = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    const result = await client.callTool({ name: 'evaluate_diagram', arguments: {
      diagram_type: 'c4-context',
      diagram_xml: emptyModel,
    } });
    const structured = result.structuredContent as {
      diagram_type: string;
      evaluated_at: string;
      valid: boolean;
      summary: { passed_checks: string[]; error_count: number; warning_count: number };
      findings: { severity: string; code: string; message: string; cell_ids: string[]; elements: unknown[] }[];
    };
    assert.equal(structured.diagram_type, 'c4-context');
    assert.equal(new Date(structured.evaluated_at).toISOString(), structured.evaluated_at);
    assert.equal(structured.valid, false);
    assert.deepEqual(structured.summary, {
      passed_checks: ['Diagram parsed', 'One diagram page', 'Library shapes conform', 'Connector appearance conforms',
        'Connector connections conform', 'No duplicate focus entry'],
      error_count: 2, warning_count: 0,
    });
    assert.deepEqual(structured.findings.map(item => item.code), ['MISSING_KEY', 'MISSING_TITLE_BLOCK']);
    assert.ok(structured.findings.every(item => item.severity === 'error' && item.message &&
      Array.isArray(item.cell_ids) && Array.isArray(item.elements)));
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), structured);
    assert.ok((result.content[0] as { text: string }).text.indexOf('"summary"') <
      (result.content[0] as { text: string }).text.indexOf('"findings"'));

    const multiPage = await client.callTool({ name: 'evaluate_diagram', arguments: {
      diagram_type: 'c4-context',
      diagram_xml: `<mxfile><diagram>${emptyModel}</diagram><diagram>${emptyModel}</diagram></mxfile>`,
    } });
    const multiPageResult = multiPage.structuredContent as typeof structured;
    assert.equal(new Date(multiPageResult.evaluated_at).toISOString(), multiPageResult.evaluated_at);
    assert.equal(multiPageResult.summary.warning_count, 1);
    assert.deepEqual(multiPageResult.findings.map(item => [item.severity, item.code]),
      [['error', 'MISSING_KEY'], ['error', 'MISSING_TITLE_BLOCK'], ['warning', 'MULTI_PAGE']]);

    const unknown = await client.callTool({ name: 'evaluate_diagram', arguments: {
      diagram_type: 'missing', diagram_xml: emptyModel,
    } });
    const unknownResult = unknown.structuredContent as typeof structured;
    assert.equal(new Date(unknownResult.evaluated_at).toISOString(), unknownResult.evaluated_at);
    assert.deepEqual(unknownResult.findings.map(item => item.code), ['UNKNOWN_DIAGRAM_TYPE']);
  } finally {
    await client.close();
  }
});

test('stdio startup ignores a nonnumeric PORT environment variable', async () => {
  const client = new Client({ name: 'diagram-eval-port-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PORT: 'abc' },
  });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'evaluate_diagram'));
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
