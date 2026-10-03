import { Cell, descendants, Graph } from '../xml.js';
import { DiagramType, LibraryEntry } from '../library.js';
import { hasBareStyle, matchGroup, styleMap } from '../match.js';
import { difference, finding, type Finding, type FindingDifference } from './result.js';

function closestGroup(graph: Graph, entry: LibraryEntry, consumed: Set<string>): Cell | undefined {
  const expectedCount = descendants(entry.graph, entry.root.id).length;
  const expectedWidth = entry.root.geometry?.getAttribute('width');
  const expectedHeight = entry.root.geometry?.getAttribute('height');
  const ranked = graph.cells.filter(cell => cell.vertex && !consumed.has(cell.id) && hasBareStyle(cell, 'group'))
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
    const candidate = closestGroup(graph, entry, consumed);
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

export function checkRequiredGroups(graph: Graph, type: DiagramType, consumed: Set<string>, findings: Finding[]): void {
  findRequiredGroup(graph, type.key, consumed, findings, 'KEY', candidate => matchGroup(type.key, candidate, graph));
  const titleGroups = findRequiredGroup(graph, type.titleBlock, consumed, findings, 'TITLE_BLOCK', candidate => matchTitleBlock(type, candidate, graph));
  for (const group of titleGroups) checkTitleFields(type, group, findings);
}
