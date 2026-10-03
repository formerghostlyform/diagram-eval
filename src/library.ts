import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { Cell, decodeLibraryXml, descendants, Graph, parseGraph, parseXml } from './xml.js';

const typeSchema = z.record(z.string().min(1), z.object({
  library: z.string().min(1),
  labelPolicy: z.enum(['fixed', 'unrestricted']).default('fixed'),
  titleStretchIds: z.array(z.string()).default([]),
  optionalTitleFields: z.array(z.string()).default([]),
  titleSampleAllowedFields: z.array(z.string()).default([]),
  warnOnDuplicateEntry: z.string().optional(),
}));

export type DiagramTypeConfig = z.infer<typeof typeSchema>[string];

export interface LibraryEntry {
  title: string;
  graph: Graph;
  root: Cell;
}

export interface DiagramType {
  id: string;
  config: DiagramTypeConfig;
  entries: LibraryEntry[];
  key: LibraryEntry;
  titleBlock: LibraryEntry;
  arrow: LibraryEntry;
}

export class TypeRegistry {
  readonly types = new Map<string, DiagramType>();

  constructor(rootDirectory = fileURLToPath(new URL('../../', import.meta.url))) {
    const rawConfig = JSON.parse(readFileSync(resolve(rootDirectory, 'diagram-types.json'), 'utf8')) as unknown;
    const config = typeSchema.parse(rawConfig);
    for (const [id, definition] of Object.entries(config)) {
      const libraryPath = resolve(rootDirectory, definition.library);
      const entries = loadLibrary(libraryPath);
      const find = (title: string): LibraryEntry => {
        const matches = entries.filter(entry => entry.title === title);
        if (matches.length !== 1) throw new Error(`${id}: expected one ${title} library entry.`);
        return matches[0]!;
      };
      if (definition.warnOnDuplicateEntry && entries.filter(entry => entry.title === definition.warnOnDuplicateEntry).length !== 1) {
        throw new Error(`${id}: duplicate warning entry is missing or ambiguous.`);
      }
      const titleBlock = find('Title Block');
      const hasMetadataLabel = [titleBlock.root, ...descendants(titleBlock.graph, titleBlock.root.id)]
        .some(cell => /%[A-Za-z][A-Za-z0-9_]*%/.test(cell.wrapper.getAttribute('label') ?? ''));
      if (!hasMetadataLabel) throw new Error(`${id}: Title Block has no metadata label.`);
      for (const stretchId of definition.titleStretchIds) {
        if (!titleBlock.graph.byId.has(stretchId)) throw new Error(`${id}: unknown Title Block stretch ID ${stretchId}.`);
      }
      this.types.set(id, {
        id,
        config: definition,
        entries,
        key: find('Key'),
        titleBlock,
        arrow: find('Arrow'),
      });
    }
  }

  list(): { diagram_type: string; entries: string[]; label_policy: string }[] {
    return [...this.types.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(type => ({
        diagram_type: type.id,
        entries: type.entries.map(entry => entry.title),
        label_policy: type.config.labelPolicy,
      }));
  }
}

function loadLibrary(path: string): LibraryEntry[] {
  const content = readFileSync(path, 'utf8').trim();
  const wrapper = /^<mxlibrary\b[^>]*>([\s\S]*)<\/mxlibrary>$/.exec(content);
  if (!wrapper) {
    throw new Error(`${path}: expected an mxlibrary export.`);
  }
  const body = wrapper[1]!;
  const items = z.array(z.object({
    title: z.string().min(1),
    w: z.number(),
    h: z.number(),
    xml: z.string().optional(),
    data: z.string().optional(),
    style: z.string().optional(),
    aspect: z.string().optional(),
  })).parse(JSON.parse(body));
  return items.map(item => {
    if (!!item.xml === !!item.data) throw new Error(`${path}: ${item.title} needs either xml or data.`);
    const source = item.xml ? decodeLibraryXml(item.xml) : imageGraphXml(item);
    const model = parseXml(source).documentElement!;
    if (model.tagName !== 'mxGraphModel') throw new Error(`${path}: ${item.title} is not a graph model.`);
    const graph = parseGraph(model);
    const roots = graph.cells.filter(cell => (cell.vertex || cell.edge) &&
      (!cell.parent || !graph.byId.get(cell.parent)?.vertex));
    if (roots.length !== 1) throw new Error(`${path}: ${item.title} must have one root cell.`);
    return { title: item.title, graph, root: roots[0]! };
  });
}

function imageGraphXml(item: { data?: string; w: number; h: number; style?: string; aspect?: string }): string {
  const style = `shape=image;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=0;${item.aspect === 'fixed' ? 'aspect=fixed;' : ''}image=${item.data};${item.style ?? ''}`;
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" parent="1" vertex="1" style="${escape(style)}"><mxGeometry as="geometry" width="${item.w}" height="${item.h}"/></mxCell></root></mxGraphModel>`;
}
