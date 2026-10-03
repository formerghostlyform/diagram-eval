import { attributes, Cell, descendants, Graph, InputError, parseDiagramContent } from './xml.js';
import { DiagramType, TypeRegistry, LibraryEntry } from './library.js';
import { hasBareStyle, isTextLabel, labelsMatchIgnoringFontSize, matchGroup, matchSingle, shapeIdentity, styleMap, styleValue } from './match.js';

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
  valid: boolean;
  findings: Finding[];
}

const CONNECTOR_STYLE_KEYS = ['strokeWidth', 'strokeColor', 'startArrow', 'endArrow'] as const;

function finding(severity: Severity, code: string, message: string, cellIds: string[] = [],
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

function finish(diagramType: string, findings: Finding[], graph?: Graph): EvaluationResult {
  if (graph) for (const item of findings) {
    const ids = new Set([...item.cell_ids, ...(item.differences ?? []).flatMap(item => item.cell_id ? [item.cell_id] : [])]);
    item.elements = [...ids].map(id => describeCell(graph, id));
  }
  findings.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
    a.code.localeCompare(b.code) ||
    a.cell_ids.join(',').localeCompare(b.cell_ids.join(',')));
  return { diagram_type: diagramType, valid: !findings.some(item => item.severity === 'error'), findings };
}

function short(value: string | null | undefined): string | undefined {
  return value == null ? undefined : value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function difference(property: string, expected: string | null | undefined,
  actual: string | null | undefined, cellId?: string): FindingDifference {
  return {
    property,
    ...(short(expected) !== undefined ? { expected: short(expected) } : {}),
    ...(short(actual) !== undefined ? { actual: short(actual) } : {}),
    ...(cellId ? { cell_id: cellId } : {}),
  };
}

function closestGroup(graph: Graph, entry: LibraryEntry): Cell | undefined {
  const expectedCount = descendants(entry.graph, entry.root.id).length;
  const expectedWidth = entry.root.geometry?.getAttribute('width');
  const expectedHeight = entry.root.geometry?.getAttribute('height');
  const ranked = graph.cells.filter(cell => cell.vertex && hasBareStyle(cell, 'group'))
    .map(cell => {
      const childCount = descendants(graph, cell.id).length;
      const score = (cell.geometry?.getAttribute('width') === expectedWidth ? 40 : 0) +
        (cell.geometry?.getAttribute('height') === expectedHeight ? 30 : 0) +
        (childCount === expectedCount ? 30 : 0) - Math.abs(childCount - expectedCount) * 5;
      return { cell, score };
    }).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= 60 ? ranked[0].cell : undefined;
}

function groupDifferences(graph: Graph, entry: LibraryEntry, candidate: Cell): FindingDifference[] {
  const reference = [entry.root, ...descendants(entry.graph, entry.root.id)];
  const actual = [candidate, ...descendants(graph, candidate.id)];
  const result: FindingDifference[] = [];
  if (reference.length !== actual.length) {
    result.push(difference('child_count', String(reference.length - 1), String(actual.length - 1), candidate.id));
    const actualLabels = new Set(actual.map(cell => cell.wrapper.getAttribute('label')));
    for (const cell of reference.slice(1)) {
      const label = cell.wrapper.getAttribute('label');
      if (label && !label.includes('%') && !actualLabels.has(label)) {
        result.push(difference('missing_child', label, undefined, candidate.id));
      }
    }
  }
  const repeated = new Set<string>();
  for (let index = 0; index < Math.min(reference.length, actual.length); index++) {
    const expected = reference[index]!;
    const received = actual[index]!;
    const label = expected.wrapper.getAttribute('label');
    const receivedLabel = received.wrapper.getAttribute('label');
    if (label !== receivedLabel) result.push(difference('label', label, receivedLabel, received.id));
    const a = styleMap(expected.inner.getAttribute('style') ?? '');
    const b = styleMap(received.inner.getAttribute('style') ?? '');
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(key) !== b.get(key)) {
        const signature = `${key}\u0000${a.get(key)}\u0000${b.get(key)}`;
        if (!repeated.has(signature)) result.push(difference(`style.${key}`, a.get(key), b.get(key), received.id));
        repeated.add(signature);
      }
    }
    for (const dimension of ['width', 'height']) {
      const x = expected.geometry?.getAttribute(dimension);
      const y = received.geometry?.getAttribute(dimension);
      if (x !== y) result.push(difference(`geometry.${dimension}`, x, y, received.id));
    }
    if (result.length >= 12) break;
  }
  return result.slice(0, 12);
}

function findRequiredGroup(graph: Graph, entry: LibraryEntry, consumed: Set<string>, findings: Finding[], code: string, match: (candidate: Cell) => Set<string> | null): Cell[][] {
  const matches: Cell[][] = [];
  for (const candidate of graph.cells) {
    if (!candidate.vertex || consumed.has(candidate.id) || !hasBareStyle(candidate, 'group')) continue;
    const matched = match(candidate);
    if (matched) matches.push([...matched].map(id => graph.byId.get(id)!));
  }
  if (matches.length === 0) {
    const candidate = closestGroup(graph, entry);
    findings.push(finding('error', `MISSING_${code}`, `No intact ${entry.title} group was found.`,
      candidate ? [candidate.id] : [], entry.title,
      candidate ? groupDifferences(graph, entry, candidate) : undefined));
    if (candidate) {
      for (const cell of [candidate, ...descendants(graph, candidate.id)]) consumed.add(cell.id);
    }
  } else {
    for (const match of matches) for (const cell of match) consumed.add(cell.id);
    if (matches.length > 1) {
      findings.push(finding('error', `DUPLICATE_${code}`, `Expected one ${entry.title}; found ${matches.length}.`,
        matches.map(match => match[0]!.id), entry.title));
    }
  }
  return matches;
}

function matchTitleBlock(type: DiagramType, candidate: Cell, graph: Graph): Set<string> | null {
  const referenceLabel = [type.titleBlock.root, ...descendants(type.titleBlock.graph, type.titleBlock.root.id)]
    .map(cell => cell.wrapper.getAttribute('label')).find(label => label?.includes('%'));
  if (!referenceLabel) return null;
  const allowedLabels = new Set([referenceLabel]);
  for (const field of type.config.optionalTitleFields) {
    for (const label of [...allowedLabels]) allowedLabels.add(label.replace(`_%${field}%`, ''));
  }
  return matchGroup(type.titleBlock, candidate, graph, type.config.titleStretchIds, 'fixed',
    (expected, received) => expected === referenceLabel ? allowedLabels.has(received ?? '') : expected === received);
}

function checkTitleFields(type: DiagramType, matched: Cell[], findings: Finding[]): void {
  const reference = [type.titleBlock.root, ...descendants(type.titleBlock.graph, type.titleBlock.root.id)]
    .find(cell => /%[A-Za-z][A-Za-z0-9_]*%/.test(cell.wrapper.getAttribute('label') ?? ''));
  if (!reference) return;
  const actual = matched.find(cell => /%[A-Za-z][A-Za-z0-9_]*%/.test(cell.wrapper.getAttribute('label') ?? ''));
  if (!actual) throw new Error(`${type.id}: matched Title Block has no metadata label.`);
  const fields = [...new Set([...(actual.wrapper.getAttribute('label') ?? '').matchAll(/%([A-Za-z][A-Za-z0-9_]*)%/g)].map(match => match[1]!))];
  for (const field of fields) {
    const value = actual.wrapper.getAttribute(field)?.trim() ?? '';
    const sample = reference.wrapper.getAttribute(field)?.trim() ?? '';
    if (!value || (value === sample && !type.config.titleSampleAllowedFields.includes(field))) {
      findings.push(finding('error', 'TITLE_FIELD_UNFILLED', `${field} must have a nonblank value${type.config.titleSampleAllowedFields.includes(field) ? '' : ' different from the library sample'}.`,
        [actual.id], 'Title Block', [difference(`metadata.${field}`,
          type.config.titleSampleAllowedFields.includes(field) ? 'nonblank' : `nonblank and different from ${sample}`,
          value || '(blank)', actual.id)]));
    }
  }
}

function likelyEditedLibraryShape(cell: Cell, type: DiagramType): boolean {
  for (let i = 0; i < cell.wrapper.attributes.length; i++) {
    const name = cell.wrapper.attributes.item(i)?.name ?? '';
    if (/^c4[A-Z]/.test(name)) return true;
  }
  if (styleValue(cell, 'metaEdit') === '1') return true;
  const identity = shapeIdentity(cell);
  if (identity.startsWith('mxgraph.c4.') || identity.startsWith('stencil(')) {
    return type.entries.some(entry => shapeIdentity(entry.root) === identity);
  }
  return false;
}

function editorStyleKeys(template: Cell, actual: Cell): Set<string> {
  const ignored = new Set(['collapsible', 'fontSize']);
  const templateStyle = styleMap(template.inner.getAttribute('style') ?? '');
  const actualStyle = styleMap(actual.inner.getAttribute('style') ?? '');
  if (!templateStyle.has('image') && !actualStyle.has('image') &&
      shapeIdentity(template) !== 'image' && shapeIdentity(actual) !== 'image') {
    for (const key of ['imageAspect', 'imageWidth', 'imageHeight', 'resizeWidth', 'resizeHeight']) ignored.add(key);
  }
  return ignored;
}

function shapeDifferences(template: Cell, actual: Cell, labels: 'fixed' | 'unrestricted',
  ignoredStyles: ReadonlySet<string>): FindingDifference[] {
  const result: FindingDifference[] = [];
  if (template.wrapper.tagName !== actual.wrapper.tagName) {
    result.push(difference('wrapper', template.wrapper.tagName, actual.wrapper.tagName));
  }
  if (labels === 'fixed' && !labelsMatchIgnoringFontSize(template.wrapper.getAttribute('label'), actual.wrapper.getAttribute('label'))) {
    result.push(difference('label', template.wrapper.getAttribute('label'), actual.wrapper.getAttribute('label')));
  }
  const expectedStyle = styleMap(template.inner.getAttribute('style') ?? '');
  const actualStyle = styleMap(actual.inner.getAttribute('style') ?? '');
  for (const key of new Set([...expectedStyle.keys(), ...actualStyle.keys()])) {
    if (!ignoredStyles.has(key) && expectedStyle.get(key) !== actualStyle.get(key)) {
      result.push(difference(`style.${key}`, expectedStyle.get(key), actualStyle.get(key)));
    }
  }
  const allowResize = styleValue(template, 'resizable') !== '0';
  const expectedGeometry = template.geometry ? attributes(template.geometry) : {};
  const actualGeometry = actual.geometry ? attributes(actual.geometry) : {};
  for (const key of new Set([...Object.keys(expectedGeometry), ...Object.keys(actualGeometry)])) {
    if (['x', 'y'].includes(key) || (allowResize && ['width', 'height'].includes(key))) continue;
    if (expectedGeometry[key] !== actualGeometry[key]) {
      result.push(difference(`geometry.${key}`, expectedGeometry[key], actualGeometry[key]));
    }
  }
  const expectedInner = attributes(template.inner);
  const actualInner = attributes(actual.inner);
  for (const key of new Set([...Object.keys(expectedInner), ...Object.keys(actualInner)])) {
    if (['id', 'parent', 'source', 'target', 'style'].includes(key) || (key === 'value' && labels === 'unrestricted')) continue;
    if (expectedInner[key] !== actualInner[key] &&
        !(key === 'value' && labels === 'fixed' && labelsMatchIgnoringFontSize(expectedInner[key] ?? null, actualInner[key] ?? null))) {
      result.push(difference(`cell.${key}`, expectedInner[key], actualInner[key]));
    }
  }
  if (template.wrapper.getAttribute('placeholders') !== actual.wrapper.getAttribute('placeholders')) {
    result.push(difference('placeholders', template.wrapper.getAttribute('placeholders'), actual.wrapper.getAttribute('placeholders')));
  }
  return result.length ? result.slice(0, 12) : [difference('structure', 'library cell structure', 'different cell structure')];
}

function closestOrdinaryEntry(cell: Cell, entries: LibraryEntry[]): LibraryEntry | undefined {
  const label = cell.wrapper.getAttribute('label');
  const actualStyle = styleMap(cell.inner.getAttribute('style') ?? '');
  const ranked = entries.filter(entry => descendants(entry.graph, entry.root.id).length === 0)
    .map(entry => {
      const expectedStyle = styleMap(entry.root.inner.getAttribute('style') ?? '');
      const styleMatches = [...expectedStyle].filter(([key, value]) => actualStyle.get(key) === value).length;
      const styleDifferences = new Set([...expectedStyle.keys(), ...actualStyle.keys()]).size - styleMatches;
      const score = (label && labelsMatchIgnoringFontSize(label, entry.root.wrapper.getAttribute('label')) ? 100 : 0) +
        (shapeIdentity(cell) === shapeIdentity(entry.root) ? 30 : 0) + styleMatches - styleDifferences * 2;
      return { entry, score };
    }).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= 20 ? ranked[0].entry : undefined;
}

function isStructuralGroup(cell: Cell, graph: Graph): boolean {
  const style = styleMap(cell.inner.getAttribute('style') ?? '');
  return cell.vertex && style.size === 1 && style.has('bare:group') &&
    !cell.wrapper.hasAttribute('label') && !(cell.inner.getAttribute('value') ?? '').trim() &&
    (graph.children.get(cell.id)?.length ?? 0) > 0;
}

function connectorDifferences(template: Cell, actual: Cell): FindingDifference[] {
  const expected = styleMap(template.inner.getAttribute('style') ?? '');
  const received = styleMap(actual.inner.getAttribute('style') ?? '');
  const result: FindingDifference[] = [];
  const keys: string[] = [...CONNECTOR_STYLE_KEYS];
  for (const side of ['start', 'end']) {
    const arrow = `${side}Arrow`;
    if ((expected.get(arrow) ?? 'none') !== 'none' || (received.get(arrow) ?? 'none') !== 'none') {
      keys.push(`${side}Fill`, `${side}Size`);
    }
  }
  for (const key of keys) {
    const left = expected.get(key);
    const right = received.get(key);
    const same = key === 'strokeColor' ? left?.toLowerCase() === right?.toLowerCase()
      : key === 'strokeWidth' || key === 'startSize' || key === 'endSize'
        ? left === right || (left !== undefined && right !== undefined && Number(left) === Number(right))
        : key === 'startArrow' || key === 'endArrow'
          ? (left ?? 'none') === (right ?? 'none')
          : left === right;
    if (!same) result.push(difference(`style.${key}`, left, right, actual.id));
  }
  return result;
}

function checkConnectors(graph: Graph, type: DiagramType, consumed: Set<string>, findings: Finding[]): void {
  const directed = new Map<string, { forward: Cell[]; backward: Cell[] }>();
  for (const edge of graph.cells.filter(cell => cell.edge && !consumed.has(cell.id))) {
    const badEndpoints = [edge.source, edge.target].filter((id): id is string => !!id)
      .filter(id => !graph.byId.get(id)?.vertex);
    if (badEndpoints.length) {
      findings.push(finding('error', 'INVALID_CONNECTION_ENDPOINT', 'Connector references a missing or non-shape endpoint.',
        [edge.id, ...badEndpoints], 'Arrow', badEndpoints.map(id => difference('endpoint', 'existing shape', id, edge.id))));
    }
    const start = styleValue(edge, 'startArrow');
    const end = styleValue(edge, 'endArrow');
    if (start && start !== 'none' && end && end !== 'none') {
      findings.push(finding('error', 'TWO_HEADED_ARROW', 'Connector has arrowheads at both ends.', [edge.id],
        'Arrow', [difference('style.startArrow', 'none', start, edge.id), difference('style.endArrow', 'one arrowhead', end, edge.id)]));
    }
    const styleDifferences = connectorDifferences(type.arrow.root, edge);
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
    if (pair.forward.length && pair.backward.length) {
      const ids = [...pair.forward, ...pair.backward].map(cell => cell.id);
      findings.push(finding('error', 'BIDIRECTIONAL_CONNECTION', 'Shapes have connections in both directions.', ids, 'Arrow'));
    }
  }
}

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
  findRequiredGroup(graph, type.key, consumed, findings, 'KEY', candidate => matchGroup(type.key, candidate, graph!));
  const titleGroups = findRequiredGroup(graph, type.titleBlock, consumed, findings, 'TITLE_BLOCK', candidate => matchTitleBlock(type, candidate, graph!));
  for (const group of titleGroups) checkTitleFields(type, group, findings);

  const ordinaryEntries = type.entries.filter(entry =>
    !['Key', 'Title Block', 'Arrow'].includes(entry.title) && entry.root.vertex);
  const matchedByEntry = new Map<string, string[]>();
  for (const entry of ordinaryEntries.filter(item => descendants(item.graph, item.root.id).length > 0)) {
    for (const candidate of graph.cells) {
      if (!candidate.vertex || consumed.has(candidate.id)) continue;
      const matched = matchGroup(entry, candidate, graph, [], type.config.labelPolicy);
      if (!matched) continue;
      for (const id of matched) consumed.add(id);
      const ids = matchedByEntry.get(entry.title) ?? [];
      ids.push(candidate.id);
      matchedByEntry.set(entry.title, ids);
    }
  }
  for (const cell of graph.cells) {
    if (!cell.vertex || consumed.has(cell.id) || isTextLabel(cell) || isStructuralGroup(cell, graph)) continue;
    const entry = ordinaryEntries.find(template => matchSingle(template, cell, type.config.labelPolicy,
      editorStyleKeys(template.root, cell), true));
    if (entry) {
      consumed.add(cell.id);
      const ids = matchedByEntry.get(entry.title) ?? [];
      ids.push(cell.id);
      matchedByEntry.set(entry.title, ids);
    } else if (likelyEditedLibraryShape(cell, type)) {
      const closest = closestOrdinaryEntry(cell, ordinaryEntries);
      findings.push(finding('error', 'MODIFIED_LIBRARY_SHAPE', 'Cell resembles a library shape but differs in style, size, or label template.',
        [cell.id], closest?.title,
        closest ? shapeDifferences(closest.root, cell, type.config.labelPolicy, editorStyleKeys(closest.root, cell)) : undefined));
    } else {
      findings.push(finding('warning', 'FOREIGN_SHAPE', 'Shape or image is not in the selected library.', [cell.id]));
    }
  }
  const duplicateTitle = type.config.warnOnDuplicateEntry;
  if (duplicateTitle) {
    const ids = matchedByEntry.get(duplicateTitle) ?? [];
    if (ids.length > 1) {
      findings.push(finding('warning', 'DUPLICATE_FOCUS_SYSTEM', `Found ${ids.length} instances of ${duplicateTitle}; expected at most one.`, ids, duplicateTitle));
    }
  }
  checkConnectors(graph, type, consumed, findings);
    return finish(diagramType, findings, graph);
  } catch (error) {
    if (error instanceof InputError) return finish(diagramType, [finding('error', error.code, error.message)], graph);
    console.error(error);
    return finish(diagramType, [finding('error', 'INTERNAL_ERROR', 'An internal error occurred while evaluating the diagram.')], graph);
  }
}
