import { attributes, Cell, descendants, Graph } from '../xml.js';
import { DiagramType, LibraryEntry } from '../library.js';
import { hasBareStyle, isTextLabel, labelsMatchIgnoringFontSize, matchGroup, matchSingle, shapeIdentity, styleMap, styleValue } from '../match.js';
import { difference, finding, type Finding, type FindingDifference } from './result.js';

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

export function checkOrdinaryShapes(graph: Graph, type: DiagramType, consumed: Set<string>, findings: Finding[]): void {
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
      findings.push(finding('warning', 'DUPLICATE_ENTRY', `Found ${ids.length} instances of ${duplicateTitle}; expected at most one.`, ids, duplicateTitle));
    }
  }
}
