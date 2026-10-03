import { Cell, Graph } from '../xml.js';
import { hasBareStyle, shapeIdentity } from '../match.js';

export type Severity = 'error' | 'warning';

export interface FindingElement {
  cell_id: string;
  kind: string;
  name?: string;
  type?: string;
  parent_id?: string;
  geometry?: { x?: number; y?: number; width?: number; height?: number };
  source_id?: string;
  source_name?: string;
  target_id?: string;
  target_name?: string;
}

export interface FindingDifference {
  property: string;
  expected?: string;
  actual?: string;
  cell_id?: string;
}

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  cell_ids: string[];
  elements: FindingElement[];
  expected_library_entry?: string;
  differences?: FindingDifference[];
}

export interface EvaluationResult {
  diagram_type: string;
  evaluated_at: string;
  valid: boolean;
  summary: {
    passed_checks: string[];
    error_count: number;
    warning_count: number;
  };
  findings: Finding[];
}

export function finding(severity: Severity, code: string, message: string, cellIds: string[] = [],
  expectedEntry?: string, differences?: FindingDifference[]): Finding {
  return {
    severity, code, message, cell_ids: [...cellIds].sort(), elements: [],
    ...(expectedEntry ? { expected_library_entry: expectedEntry } : {}),
    ...(differences?.length ? { differences } : {}),
  };
}

function readable(value: string): string {
  return value.replace(/%([A-Za-z][A-Za-z0-9_]*)%/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cellName(cell: Cell): string | undefined {
  const source = cell.wrapper.getAttribute('c4Name') || cell.wrapper.getAttribute('c4Description') ||
    cell.wrapper.getAttribute('label') || cell.inner.getAttribute('value');
  if (!source) return undefined;
  const expanded = source.replace(/%([A-Za-z][A-Za-z0-9_]*)%/g,
    (_whole, key: string) => cell.wrapper.getAttribute(key) ?? key);
  return readable(expanded) || undefined;
}

function describeCell(graph: Graph, id: string): FindingElement {
  const cell = graph.byId.get(id);
  if (!cell) return { cell_id: id, kind: 'missing' };
  const source = cell.source ? graph.byId.get(cell.source) : undefined;
  const target = cell.target ? graph.byId.get(cell.target) : undefined;
  const identity = shapeIdentity(cell);
  const name = cellName(cell);
  const geometry = Object.fromEntries(['x', 'y', 'width', 'height'].flatMap(key => {
    const raw = cell.geometry?.getAttribute(key);
    return raw != null && raw.trim() !== '' && Number.isFinite(Number(raw)) ? [[key, Number(raw)]] : [];
  })) as FindingElement['geometry'];
  return {
    cell_id: id,
    kind: cell.edge ? 'connector' : hasBareStyle(cell, 'group') ? 'group' : identity.startsWith('stencil(') ? 'stencil' : identity,
    ...(name ? { name } : {}),
    ...(cell.wrapper.getAttribute('c4Type') ? { type: readable(cell.wrapper.getAttribute('c4Type')!) } : {}),
    ...(cell.parent && !['0', '1'].includes(cell.parent) ? { parent_id: cell.parent } : {}),
    ...(geometry && Object.keys(geometry).length ? { geometry } : {}),
    ...(cell.source ? { source_id: cell.source } : {}),
    ...(source && cellName(source) ? { source_name: cellName(source) } : {}),
    ...(cell.target ? { target_id: cell.target } : {}),
    ...(target && cellName(target) ? { target_name: cellName(target) } : {}),
  };
}

export function finish(diagramType: string, findings: Finding[], graph?: Graph, passedChecks: string[] = []): EvaluationResult {
  if (graph) for (const item of findings) {
    const ids = new Set([...item.cell_ids, ...(item.differences ?? []).flatMap(item => item.cell_id ? [item.cell_id] : [])]);
    item.elements = [...ids].map(id => describeCell(graph, id));
  }
  findings.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
    a.code.localeCompare(b.code) ||
    a.cell_ids.join(',').localeCompare(b.cell_ids.join(',')));
  const errorCount = findings.filter(item => item.severity === 'error').length;
  return {
    diagram_type: diagramType,
    evaluated_at: new Date().toISOString(),
    valid: errorCount === 0,
    summary: { passed_checks: passedChecks, error_count: errorCount, warning_count: findings.length - errorCount },
    findings,
  };
}

function short(value: string | null | undefined): string | undefined {
  return value == null ? undefined : value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

export function difference(property: string, expected: string | null | undefined,
  actual: string | null | undefined, cellId?: string): FindingDifference {
  return {
    property,
    ...(short(expected) !== undefined ? { expected: short(expected) } : {}),
    ...(short(actual) !== undefined ? { actual: short(actual) } : {}),
    ...(cellId ? { cell_id: cellId } : {}),
  };
}
