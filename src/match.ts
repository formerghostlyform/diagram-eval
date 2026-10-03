import { Cell, descendants, elementChildren, Graph, attributes } from './xml.js';
import { LibraryEntry } from './library.js';
import type { Element } from '@xmldom/xmldom';

export type LabelPolicy = 'fixed' | 'unrestricted';

export function styleMap(style: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const token of style.split(';').map(value => value.trim()).filter(Boolean)) {
    const split = token.indexOf('=');
    if (split < 0) result.set(`bare:${token}`, '1');
    else result.set(token.slice(0, split), token.slice(split + 1));
  }
  return result;
}

export function styleValue(cell: Cell, key: string): string | undefined {
  return styleMap(cell.inner.getAttribute('style') ?? '').get(key);
}

// draw.io may store text sizing in the cell style or inside its HTML label.
export function labelsMatchIgnoringFontSize(expected: string | null, actual: string | null): boolean {
  const normalize = (label: string | null): string | null => {
    if (label === null) return null;
    let normalized = label.replace(
      /\sstyle\s*=\s*(["'])(.*?)\1/gi,
      (_attribute, quote: string, value: string) => {
        const declarations = value.split(';').map(part => part.trim()).filter(Boolean)
          .filter(part => !/^font-size\s*:/i.test(part));
        return declarations.length ? ` style=${quote}${declarations.join(';')}${quote}` : '';
      },
    ).replace(/(<font\b[^>]*?)\s+size\s*=\s*(["']).*?\2/gi, '$1');
    let previous: string;
    do {
      previous = normalized;
      normalized = normalized.replace(/<(font|span)>((?:(?!<\/?\1\b)[\s\S])*)<\/\1>/gi, '$2');
    } while (normalized !== previous);
    return normalized;
  };
  return normalize(expected) === normalize(actual);
}

export function hasBareStyle(cell: Cell, name: string): boolean {
  return styleMap(cell.inner.getAttribute('style') ?? '').has(`bare:${name}`);
}

export function shapeIdentity(cell: Cell): string {
  const style = styleMap(cell.inner.getAttribute('style') ?? '');
  const explicit = style.get('shape');
  if (explicit) return explicit;
  if (style.has('bare:text')) return 'text';
  if (style.has('bare:edgeLabel')) return 'edgeLabel';
  if (style.has('bare:group')) return 'group';
  return cell.edge ? 'edge' : 'rectangle';
}

export function isTextLabel(cell: Cell): boolean {
  return cell.vertex && ['text', 'edgeLabel'].includes(shapeIdentity(cell));
}

function sameStyle(left: Cell, right: Cell, ignoredKeys: ReadonlySet<string>): boolean {
  const a = styleMap(left.inner.getAttribute('style') ?? '');
  const b = styleMap(right.inner.getAttribute('style') ?? '');
  for (const key of ignoredKeys) {
    a.delete(key);
    b.delete(key);
  }
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

function sameScalar(a: string, b: string): boolean {
  const first = Number(a);
  const second = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(first) && Number.isFinite(second)
    ? Math.abs(first - second) <= 1e-6
    : a === b;
}

function sameAttributes(a: Element, b: Element, omit: Set<string>, widthDelta = 0, stretchWidth = false): boolean {
  const first = attributes(a);
  const second = attributes(b);
  const names = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const name of names) {
    if (omit.has(name)) continue;
    if (name === 'width' && stretchWidth) {
      const expected = Number(first.width) + widthDelta;
      if (!Number.isFinite(expected) || expected <= 0 || !sameScalar(String(expected), second.width ?? '')) return false;
    } else if (first[name] === undefined || second[name] === undefined || !sameScalar(first[name], second[name])) {
      return false;
    }
  }
  return true;
}

function sameElementTree(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName || !sameAttributes(a, b, new Set())) return false;
  const first = elementChildren(a);
  const second = elementChildren(b);
  if (first.length !== second.length) return false;
  if ((a.textContent ?? '').trim() !== (b.textContent ?? '').trim() && first.length === 0) return false;
  return first.every((child, index) => sameElementTree(child, second[index]!));
}

function sameGeometry(template: Cell, actual: Cell, kind: 'single-vertex' | 'single-edge' | 'group', root: boolean, widthDelta: number, stretchWidth: boolean, allowResize: boolean): boolean {
  if (!template.geometry || !actual.geometry) return template.geometry === actual.geometry;
  if (kind === 'single-edge') return true;
  const omit = root || kind === 'single-vertex' ? new Set(['x', 'y']) : new Set<string>();
  if (allowResize) {
    for (const dimension of ['width', 'height']) {
      if (template.geometry.hasAttribute(dimension)) {
        const size = Number(actual.geometry.getAttribute(dimension));
        if (!Number.isFinite(size) || size <= 0) return false;
        omit.add(dimension);
      }
    }
  }
  if (!sameAttributes(template.geometry, actual.geometry, omit, widthDelta, stretchWidth)) return false;
  const first = elementChildren(template.geometry);
  const second = elementChildren(actual.geometry);
  return first.length === second.length && first.every((child, index) => sameElementTree(child, second[index]!));
}

function sameCell(template: Cell, actual: Cell, kind: 'single-vertex' | 'single-edge' | 'group', labels: LabelPolicy, root: boolean, widthDelta: number, stretchWidth: boolean, ignoredStyleKeys: ReadonlySet<string> = new Set(), labelMatches?: (expected: string | null, received: string | null) => boolean, allowResize = false): boolean {
  if (template.wrapper.tagName !== actual.wrapper.tagName || template.vertex !== actual.vertex || template.edge !== actual.edge) return false;
  if (!sameStyle(template, actual, ignoredStyleKeys)) return false;
  if (template.wrapper !== template.inner) {
    const a = attributes(template.wrapper);
    const b = attributes(actual.wrapper);
    if (a.placeholders !== b.placeholders) return false;
    if (labels === 'fixed' && !(labelMatches?.(a.label ?? null, b.label ?? null) ?? a.label === b.label)) return false;
  }
  const omit = new Set(['id', 'parent', 'source', 'target', 'style']);
  if (labels === 'unrestricted' || labelMatches) omit.add('value');
  if (labels === 'fixed' && labelMatches && !labelMatches(template.inner.getAttribute('value'), actual.inner.getAttribute('value'))) return false;
  if (!sameAttributes(template.inner, actual.inner, omit)) return false;
  if (!sameGeometry(template, actual, kind, root, widthDelta, stretchWidth, allowResize)) return false;
  const first = elementChildren(template.inner).filter(child => child.tagName !== 'mxGeometry');
  const second = elementChildren(actual.inner).filter(child => child.tagName !== 'mxGeometry');
  return first.length === second.length && first.every((child, index) => sameElementTree(child, second[index]!));
}

export function matchSingle(entry: LibraryEntry, actual: Cell, labels: LabelPolicy, ignoredStyleKeys: ReadonlySet<string> = new Set(), allowFontSizeChanges = false): boolean {
  if (descendants(entry.graph, entry.root.id).length > 0) return false;
  if (entry.root.vertex && actual.vertex) {
    const allowResize = styleValue(entry.root, 'resizable') !== '0';
    return sameCell(entry.root, actual, 'single-vertex', labels, true, 0, false, ignoredStyleKeys,
      allowFontSizeChanges ? labelsMatchIgnoringFontSize : undefined, allowResize);
  }
  if (entry.root.edge && actual.edge) return sameCell(entry.root, actual, 'single-edge', labels, true, 0, false, ignoredStyleKeys);
  return false;
}

export function matchGroup(entry: LibraryEntry, actualRoot: Cell, actualGraph: Graph, stretchIds: readonly string[] = [], labels: LabelPolicy = 'fixed', labelMatches?: (expected: string | null, received: string | null) => boolean): Set<string> | null {
  if (!actualRoot.vertex || !entry.root.vertex) return null;
  const referenceWidth = Number(entry.root.geometry?.getAttribute('width'));
  const currentWidth = Number(actualRoot.geometry?.getAttribute('width'));
  if (!Number.isFinite(referenceWidth) || !Number.isFinite(currentWidth)) return null;
  const widthDelta = stretchIds.length > 0 ? currentWidth - referenceWidth : 0;
  const templateCells = [entry.root, ...descendants(entry.graph, entry.root.id)];
  const actualCells = [actualRoot, ...descendants(actualGraph, actualRoot.id)];
  if (templateCells.length !== actualCells.length) return null;

  const stretch = (cell: Cell): boolean => stretchIds.includes(cell.id);

  const visit = (template: Cell, actual: Cell, mapping: Map<string, string>): Map<string, string> | null => {
    if (!sameCell(template, actual, 'group', labels, template.id === entry.root.id, widthDelta, stretch(template), new Set(), labelMatches)) return null;
    const next = new Map(mapping);
    next.set(template.id, actual.id);
    const expectedChildren = entry.graph.children.get(template.id) ?? [];
    const actualChildren = actualGraph.children.get(actual.id) ?? [];
    if (expectedChildren.length !== actualChildren.length) return null;
    const assign = (index: number, used: Set<string>, assigned: Map<string, string>): Map<string, string> | null => {
      if (index === expectedChildren.length) return assigned;
      const expected = expectedChildren[index]!;
      for (const candidate of actualChildren) {
        if (used.has(candidate.id)) continue;
        const matched = visit(expected, candidate, assigned);
        if (!matched) continue;
        const result = assign(index + 1, new Set([...used, candidate.id]), matched);
        if (result) return result;
      }
      return null;
    };
    return assign(0, new Set(), next);
  };

  const mapping = visit(entry.root, actualRoot, new Map());
  if (!mapping) return null;
  for (const template of templateCells) {
    const actual = actualGraph.byId.get(mapping.get(template.id)!);
    if (!actual) return null;
    for (const terminal of ['source', 'target'] as const) {
      const expected = template[terminal];
      if (expected ? mapping.get(expected) !== actual[terminal] : actual[terminal] !== undefined) return null;
    }
  }
  return new Set(mapping.values());
}
