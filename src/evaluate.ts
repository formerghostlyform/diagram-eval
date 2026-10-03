import { Graph, InputError, parseDiagramContent } from './xml.js';
import { TypeRegistry } from './library.js';
import { checkRequiredGroups } from './evaluation/required.js';
import { checkOrdinaryShapes } from './evaluation/shapes.js';
import { checkConnectors } from './evaluation/connectors.js';
import { finding, finish, type EvaluationResult, type Finding } from './evaluation/result.js';

export type { Severity, FindingElement, FindingDifference, Finding, EvaluationResult } from './evaluation/result.js';

export function evaluateDiagram(registry: TypeRegistry, diagramType: string, diagramXml: string): EvaluationResult {
  const findings: Finding[] = [];
  const type = registry.types.get(diagramType);
  if (!type) {
    return finish(diagramType, [finding('error', 'UNKNOWN_DIAGRAM_TYPE', `Unknown diagram type: ${diagramType}.`)]);
  }
  let graph: Graph | undefined;
  try {
    graph = parseDiagramContent(diagramXml);
    const consumed = new Set<string>();
    checkRequiredGroups(graph, type, consumed, findings);
    checkOrdinaryShapes(graph, type, consumed, findings);
    checkConnectors(graph, type, consumed, findings);
    return finish(diagramType, findings, graph);
  } catch (error) {
    if (error instanceof InputError) return finish(diagramType, [finding('error', error.code, error.message)], graph);
    console.error(error);
    return finish(diagramType, [finding('error', 'INTERNAL_ERROR', 'An internal error occurred while evaluating the diagram.')], graph);
  }
}
