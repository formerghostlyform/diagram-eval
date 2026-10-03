import { Graph, InputError, parseDiagramContent } from './xml.js';
import { TypeRegistry } from './library.js';
import { checkRequiredGroups } from './evaluation/required.js';
import { checkOrdinaryShapes } from './evaluation/shapes.js';
import { checkConnectors } from './evaluation/connectors.js';
import { finding, finish, type EvaluationResult, type Finding } from './evaluation/result.js';

export type { Severity, FindingElement, FindingDifference, Finding, EvaluationResult } from './evaluation/result.js';

function passedChecks(findings: Finding[], checkDuplicateEntry: boolean): string[] {
  const codes = new Set(findings.map(item => item.code));
  const checks: [string, string[]][] = [
    ['Diagram parsed', []],
    ['One diagram page', ['MULTI_PAGE']],
    ['One intact Key', ['MISSING_KEY', 'DUPLICATE_KEY']],
    ['One intact Title Block with filled metadata', ['MISSING_TITLE_BLOCK', 'DUPLICATE_TITLE_BLOCK', 'TITLE_FIELD_UNFILLED']],
    ['Library shapes conform', ['MODIFIED_LIBRARY_SHAPE', 'FOREIGN_SHAPE']],
    ['Connector appearance conforms', ['NONSTANDARD_CONNECTOR', 'TWO_HEADED_ARROW']],
    ['Connector connections conform', ['UNCONNECTED_CONNECTOR', 'INVALID_CONNECTION_ENDPOINT', 'BIDIRECTIONAL_CONNECTION']],
  ];
  if (checkDuplicateEntry) checks.push(['No duplicate focus entry', ['DUPLICATE_ENTRY']]);
  return checks.filter(([, blockedBy]) => blockedBy.every(code => !codes.has(code))).map(([label]) => label);
}

function multiPageWarning(pageCount: number): Finding {
  return finding('warning', 'MULTI_PAGE',
    `Found ${pageCount} diagram pages; later pages were not evaluated.`);
}

export function evaluateDiagram(registry: TypeRegistry, diagramType: string, diagramXml: string): EvaluationResult {
  const findings: Finding[] = [];
  const type = registry.types.get(diagramType);
  if (!type) {
    return finish(diagramType, [finding('error', 'UNKNOWN_DIAGRAM_TYPE', `Unknown diagram type: ${diagramType}.`)]);
  }
  let graph: Graph | undefined;
  try {
    const parsed = parseDiagramContent(diagramXml);
    graph = parsed.graph;
    if (parsed.pageCount > 1) findings.push(multiPageWarning(parsed.pageCount));
    const consumed = new Set<string>();
    checkRequiredGroups(graph, type, consumed, findings);
    checkOrdinaryShapes(graph, type, consumed, findings);
    checkConnectors(graph, type, consumed, findings);
    return finish(diagramType, findings, graph, passedChecks(findings, !!type.config.warnOnDuplicateEntry));
  } catch (error) {
    if (error instanceof InputError) return finish(diagramType,
      [finding('error', error.code, error.message), ...(error.pageCount && error.pageCount > 1
        ? [multiPageWarning(error.pageCount)] : [])], graph);
    console.error(error);
    return finish(diagramType, [finding('error', 'INTERNAL_ERROR', 'An internal error occurred while evaluating the diagram.')], graph);
  }
}
