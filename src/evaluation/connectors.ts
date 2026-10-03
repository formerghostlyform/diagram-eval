import { Cell, Graph } from '../xml.js';
import { DiagramType } from '../library.js';
import { styleMap } from '../match.js';
import { difference, finding, type Finding, type FindingDifference } from './result.js';

const CONNECTOR_STYLE_KEYS = ['strokeWidth', 'strokeColor', 'startArrow', 'endArrow'] as const;
const EDGE_STYLE_DEFAULTS = {
  endArrow: 'classic', startArrow: 'none', strokeWidth: '1', endFill: '1', startFill: '1', endSize: '6', startSize: '6',
} as const;

function normalizeEdgeStyle(style: Map<string, string>): Map<string, string> {
  const normalized = new Map(style);
  for (const [key, value] of Object.entries(EDGE_STYLE_DEFAULTS)) {
    if (!normalized.has(key)) normalized.set(key, value);
  }
  return normalized;
}

function connectorDifferences(template: Cell, actual: Cell): FindingDifference[] {
  const expected = normalizeEdgeStyle(styleMap(template.inner.getAttribute('style') ?? ''));
  const received = normalizeEdgeStyle(styleMap(actual.inner.getAttribute('style') ?? ''));
  const result: FindingDifference[] = [];
  const keys: string[] = [...CONNECTOR_STYLE_KEYS];
  for (const side of ['start', 'end']) {
    const arrow = `${side}Arrow`;
    if (expected.get(arrow) !== 'none' || received.get(arrow) !== 'none') {
      keys.push(`${side}Fill`, `${side}Size`);
    }
  }
  for (const key of keys) {
    const left = expected.get(key);
    const right = received.get(key);
    const same = key === 'strokeColor' ? left?.toLowerCase() === right?.toLowerCase()
      : key === 'strokeWidth' || key === 'startSize' || key === 'endSize'
        ? Number(left) === Number(right)
        : left === right;
    if (!same) result.push(difference(`style.${key}`, left, right, actual.id));
  }
  return result;
}

export function checkConnectors(graph: Graph, type: DiagramType, consumed: Set<string>, findings: Finding[]): void {
  const directed = new Map<string, { forward: Cell[]; backward: Cell[] }>();
  for (const edge of graph.cells.filter(cell => cell.edge && !consumed.has(cell.id))) {
    if (!edge.source || !edge.target) {
      findings.push(finding('error', 'UNCONNECTED_CONNECTOR', 'Connector is missing a source or target.', [edge.id], 'Arrow'));
    }
    const badEndpoints = [edge.source, edge.target].filter((id): id is string => !!id)
      .filter(id => !graph.byId.get(id)?.vertex);
    if (badEndpoints.length) {
      findings.push(finding('error', 'INVALID_CONNECTION_ENDPOINT', 'Connector references a missing or non-shape endpoint.',
        [edge.id, ...badEndpoints], 'Arrow', badEndpoints.map(id => difference('endpoint', 'existing shape', id, edge.id))));
    }
    const normalizedStyle = normalizeEdgeStyle(styleMap(edge.inner.getAttribute('style') ?? ''));
    const start = normalizedStyle.get('startArrow')!;
    const end = normalizedStyle.get('endArrow')!;
    const twoHeaded = start !== 'none' && end !== 'none';
    if (twoHeaded && type.config.forbidTwoHeaded) {
      findings.push(finding('error', 'TWO_HEADED_ARROW', 'Connector has arrowheads at both ends.', [edge.id],
        'Arrow', [difference('style.startArrow', 'none', start, edge.id), difference('style.endArrow', 'one arrowhead', end, edge.id)]));
    }
    const styleDifferences = connectorDifferences(type.arrow.root, edge)
      .filter(item => !(twoHeaded && type.config.forbidTwoHeaded) || item.property !== 'style.startArrow');
    if (styleDifferences.length) {
      findings.push(finding('error', 'NONSTANDARD_CONNECTOR', 'Connector differs from the library Arrow weight, color, or arrowhead style.',
        [edge.id], 'Arrow', styleDifferences));
    }
    if (edge.source && edge.target && edge.source !== edge.target) {
      const [low, high] = [edge.source, edge.target].sort();
      const key = `${low}\u0000${high}`;
      const pair = directed.get(key) ?? { forward: [], backward: [] };
      if (edge.source === low) pair.forward.push(edge);
      else pair.backward.push(edge);
      directed.set(key, pair);
    }
  }
  for (const pair of directed.values()) {
    if (type.config.forbidBidirectional && pair.forward.length && pair.backward.length) {
      const ids = [...pair.forward, ...pair.backward].map(cell => cell.id);
      findings.push(finding('error', 'BIDIRECTIONAL_CONNECTION', 'Shapes have connections in both directions.', ids, 'Arrow'));
    }
  }
}
