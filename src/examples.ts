import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDiagram } from './evaluate.js';
import { TypeRegistry } from './library.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const examplesDirectory = resolve(projectRoot, 'Examples');
const registry = new TypeRegistry(projectRoot);
const results = readdirSync(examplesDirectory)
  .filter(name => name.toLowerCase().endsWith('.drawio'))
  .sort()
  .map(name => {
    const diagramType = /context/i.test(name) ? 'c4-context'
      : /container/i.test(name) ? 'c4-container'
      : undefined;
    if (!diagramType) throw new Error(`Cannot infer diagram type from example: ${name}`);
    const xml = readFileSync(resolve(examplesDirectory, name), 'utf8');
    return { name, result: evaluateDiagram(registry, diagramType, xml) };
  });

if (results.length === 0) throw new Error('No .drawio files found in Examples.');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const { name, result } of results) {
    const errors = result.findings.filter(item => item.severity === 'error').length;
    const warnings = result.findings.length - errors;
    const counts = new Map<string, number>();
    for (const item of result.findings) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    const summary = [...counts].map(([code, count]) => `${code} ${count}`).join(', ');
    console.log(`${result.valid ? 'PASS' : 'FAIL'} ${name} (${result.diagram_type}): ${errors} errors, ${warnings} warnings`);
    if (summary) console.log(`  ${summary}`);
  }
  console.log(`${results.filter(item => item.result.valid).length}/${results.length} examples valid`);
}

if (results.some(item => !item.result.valid)) process.exitCode = 1;
