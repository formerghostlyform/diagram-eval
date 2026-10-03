import { inflateRawSync } from 'node:zlib';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';

export class InputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface Cell {
  id: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  wrapper: Element;
  inner: Element;
  geometry?: Element;
}

export interface Graph {
  cells: Cell[];
  byId: Map<string, Cell>;
  children: Map<string, Cell[]>;
}

const MAX_XML_BYTES = 20 * 1024 * 1024;

export function elementChildren(element: Element): Element[] {
  const result: Element[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) result.push(node as Element);
  }
  return result;
}

export function attributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const item = element.attributes.item(i);
    if (item) result[item.name] = item.value;
  }
  return result;
}

export function parseXml(xml: string): Document {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new InputError('INPUT_TOO_LARGE', 'XML exceeds the 20 MiB limit.');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new InputError('UNSAFE_XML', 'DOCTYPE and ENTITY declarations are not accepted.');
  }
  const problems: string[] = [];
  let document: Document;
  try {
    document = new DOMParser({
      onError: (_level, message) => problems.push(message),
    }).parseFromString(xml, 'text/xml');
  } catch (error) {
    throw new InputError('MALFORMED_XML', error instanceof Error ? error.message : 'XML is malformed.');
  }
  if (!document.documentElement || problems.length > 0 || document.getElementsByTagName('parsererror').length > 0) {
    throw new InputError('MALFORMED_XML', problems[0] ?? 'XML is malformed.');
  }
  return document;
}

export function inflateDiagram(encoded: string): string {
  const clean = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new InputError('MALFORMED_XML', 'Compressed diagram is not valid Base64.');
  }
  try {
    const inflated = inflateRawSync(Buffer.from(clean, 'base64'), { maxOutputLength: MAX_XML_BYTES });
    const text = inflated.toString('utf8');
    return text.trimStart().startsWith('<') ? text : decodeURIComponent(text);
  } catch {
    throw new InputError('MALFORMED_XML', 'Compressed diagram could not be decoded.');
  }
}

export function parseDiagramContent(content: string): Graph {
  const document = parseXml(content);
  const root = document.documentElement!;
  if (root.tagName === 'mxGraphModel') return parseGraph(root);
  if (root.tagName !== 'mxfile') {
    throw new InputError('UNSUPPORTED_FORMAT', 'Expected an mxfile or mxGraphModel document.');
  }
  const pages = elementChildren(root).filter(child => child.tagName === 'diagram');
  if (pages.length !== 1) {
    throw new InputError('MULTI_PAGE', `Expected one diagram page; found ${pages.length}.`);
  }
  const page = pages[0]!;
  const models = elementChildren(page).filter(child => child.tagName === 'mxGraphModel');
  if (models.length === 1) return parseGraph(models[0]!);
  if (models.length > 1) throw new InputError('MALFORMED_XML', 'A page contains multiple graph models.');
  const decoded = inflateDiagram(page.textContent ?? '');
  const model = parseXml(decoded).documentElement!;
  if (model.tagName !== 'mxGraphModel') {
    throw new InputError('UNSUPPORTED_FORMAT', 'Decoded page is not an mxGraphModel.');
  }
  return parseGraph(model);
}

export function parseGraph(model: Element): Graph {
  const roots = elementChildren(model).filter(child => child.tagName === 'root');
  if (roots.length !== 1) throw new InputError('MALFORMED_XML', 'Graph model must contain one root.');
  const cells: Cell[] = [];
  const byId = new Map<string, Cell>();
  const children = new Map<string, Cell[]>();
  for (const wrapper of elementChildren(roots[0]!)) {
    const inner = wrapper.tagName === 'mxCell'
      ? wrapper
      : elementChildren(wrapper).find(child => child.tagName === 'mxCell');
    if (!inner) throw new InputError('MALFORMED_XML', `Unsupported graph node: ${wrapper.tagName}.`);
    const id = wrapper.getAttribute('id') ?? inner.getAttribute('id');
    if (!id) throw new InputError('MALFORMED_XML', 'A graph cell is missing its ID.');
    if (byId.has(id)) throw new InputError('MALFORMED_XML', `Duplicate cell ID: ${id}.`);
    const cell: Cell = {
      id,
      parent: inner.getAttribute('parent') ?? undefined,
      source: inner.getAttribute('source') ?? undefined,
      target: inner.getAttribute('target') ?? undefined,
      vertex: inner.getAttribute('vertex') === '1',
      edge: inner.getAttribute('edge') === '1',
      wrapper,
      inner,
      geometry: elementChildren(inner).find(child => child.tagName === 'mxGeometry'),
    };
    cells.push(cell);
    byId.set(id, cell);
  }
  for (const cell of cells) {
    if (cell.parent && !byId.has(cell.parent)) {
      throw new InputError('MALFORMED_XML', `Cell ${cell.id} has an unknown parent.`);
    }
    if (cell.parent) {
      const siblings = children.get(cell.parent) ?? [];
      siblings.push(cell);
      children.set(cell.parent, siblings);
    }
  }
  for (const cell of cells) {
    const seen = new Set<string>();
    let cursor: Cell | undefined = cell;
    while (cursor?.parent) {
      if (seen.has(cursor.id)) throw new InputError('MALFORMED_XML', 'Cell parent cycle detected.');
      seen.add(cursor.id);
      cursor = byId.get(cursor.parent);
    }
  }
  return { cells, byId, children };
}

export function decodeLibraryXml(encoded: string): string {
  const trimmed = encoded.trim();
  if (trimmed.startsWith('<')) return trimmed;
  if (trimmed.startsWith('&lt;')) {
    const wrapper = parseXml(`<encoded>${trimmed}</encoded>`);
    return wrapper.documentElement!.textContent ?? '';
  }
  return inflateDiagram(trimmed);
}

export function descendants(graph: Graph, rootId: string): Cell[] {
  const result: Cell[] = [];
  const visit = (id: string): void => {
    for (const child of graph.children.get(id) ?? []) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return result;
}
