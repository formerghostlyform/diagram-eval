import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'diagram-eval-example-report', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/server.js')] });
const results = [];
try {
  await client.connect(transport);
  for (const name of readdirSync('Examples').filter(name => name.toLowerCase().endsWith('.drawio')).sort()) {
    const diagram_type = /context/i.test(name) ? 'c4-context' : /container/i.test(name) ? 'c4-container' : undefined;
    if (!diagram_type) throw new Error(`Cannot infer diagram type from example: ${name}`);
    const diagram_xml = readFileSync(resolve('Examples', name), 'utf8');
    const response = await client.callTool({ name: 'evaluate_diagram', arguments: { diagram_type, diagram_xml } });
    if (response.isError || !response.structuredContent) throw new Error(`MCP evaluation failed for ${name}`);
    results.push({ name, result: response.structuredContent });
  }
} finally {
  await client.close();
}

writeFileSync('example-mcp-findings.json', `${JSON.stringify(results, null, 2)}\n`);
const lines = ['# Example diagram findings from MCP', '',
  'Each result below came from an `evaluate_diagram` MCP tool call.', ''];
for (const { name, result } of results) {
  const errors = result.findings.filter(item => item.severity === 'error').length;
  const warnings = result.findings.length - errors;
  lines.push(`## ${name}`, '',
    `Type: \`${result.diagram_type}\` · ${result.valid ? 'PASS' : 'FAIL'} · ${errors} errors · ${warnings} warnings`, '');
  if (!result.findings.length) lines.push('No findings.', '');
  for (const finding of result.findings) {
    lines.push(`- **${finding.severity.toUpperCase()} ${finding.code}** — ${finding.message}`);
    for (const element of finding.elements) {
      const identity = element.name ? `${element.name} (${element.kind})` : element.kind;
      const endpoints = element.source_name || element.target_name
        ? ` · ${element.source_name ?? element.source_id ?? '?'} → ${element.target_name ?? element.target_id ?? '?'}` : '';
      lines.push(`  - Element: ${identity} — cell \`${element.cell_id}\`${element.parent_id ? `, parent \`${element.parent_id}\`` : ''}${endpoints}`);
    }
    if (finding.expected_library_entry) lines.push(`  - Library entry: \`${finding.expected_library_entry}\``);
    for (const diff of finding.differences ?? []) {
      lines.push(`  - Difference: \`${diff.property}\`${diff.expected === undefined ? '' : `; expected ${JSON.stringify(diff.expected)}`}${diff.actual === undefined ? '' : `; actual ${JSON.stringify(diff.actual)}`}${diff.cell_id ? `; cell \`${diff.cell_id}\`` : ''}`);
    }
  }
  if (result.findings.length) lines.push('');
}
writeFileSync('example-mcp-findings.md', `${lines.join('\n')}\n`);
console.log(`Wrote MCP findings for ${results.length} diagrams.`);
