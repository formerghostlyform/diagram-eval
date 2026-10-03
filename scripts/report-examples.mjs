import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { exampleTypeOverride, inferExampleType } from '../dist/src/example-type.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const examplesDirectory = resolve(projectRoot, 'Examples');
const typeOverride = exampleTypeOverride(process.argv.slice(2));
const client = new Client({ name: 'diagram-eval-example-report', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(projectRoot, 'dist/src/server.js')] });
const results = [];
try {
  await client.connect(transport);
  for (const name of readdirSync(examplesDirectory).filter(name => name.toLowerCase().endsWith('.drawio')).sort()) {
    const diagram_type = inferExampleType(name, typeOverride);
    const diagram_xml = readFileSync(resolve(examplesDirectory, name), 'utf8');
    const response = await client.callTool({ name: 'evaluate_diagram', arguments: { diagram_type, diagram_xml } });
    if (response.isError || !response.structuredContent) throw new Error(`MCP evaluation failed for ${name}`);
    results.push({ name, result: response.structuredContent });
  }
} finally {
  await client.close();
}

writeFileSync(resolve(projectRoot, 'example-mcp-findings.json'), `${JSON.stringify(results, null, 2)}\n`);
const lines = ['# Example diagram findings from MCP', '',
  'Each result below came from an `evaluate_diagram` MCP tool call.', ''];
for (const { name, result } of results) {
  const errors = result.findings.filter(item => item.severity === 'error').length;
  const warnings = result.findings.length - errors;
  lines.push(`## ${name}`, '',
    `Type: \`${result.diagram_type}\` · ${result.valid ? 'PASS' : 'FAIL'} · ${errors} errors · ${warnings} warnings`, '');
  lines.push(`### Passed checks (${result.summary.passed_checks.length})`, '');
  for (const check of result.summary.passed_checks) lines.push(`- ${check}`);
  if (!result.summary.passed_checks.length) lines.push('None.');
  lines.push('', '### Failures and warnings', '');
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
writeFileSync(resolve(projectRoot, 'example-mcp-findings.md'), `${lines.join('\n')}\n`);
console.log(`Wrote MCP findings for ${results.length} diagrams.`);
