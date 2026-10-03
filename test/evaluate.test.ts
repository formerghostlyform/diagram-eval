import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { XMLSerializer, type Element } from '@xmldom/xmldom';
import { evaluateDiagram } from '../src/evaluate.js';
import { TypeRegistry } from '../src/library.js';
import { matchSingle } from '../src/match.js';
import { descendants, MAX_DEPTH, parseGraph, parseXml } from '../src/xml.js';

const registry = new TypeRegistry();
const serializer = new XMLSerializer();

class DiagramFixture {
  private readonly document = parseXml('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>');
  private readonly root = this.document.getElementsByTagName('root')[0]!;
  private readonly type;

  constructor(readonly diagramType: string) {
    this.type = registry.types.get(diagramType)!;
  }

  add(title: string, prefix: string, options: { titleFilled?: boolean; titleWidthDelta?: number; omitContainerName?: boolean; source?: string; target?: string } = {}): string {
    const entry = this.type.entries.find(item => item.title === title)!;
    const cells = [entry.root, ...descendants(entry.graph, entry.root.id)];
    const referenceWidth = Number(entry.root.geometry?.getAttribute('width'));
    for (const cell of cells) {
      const clone = cell.wrapper.cloneNode(true) as Element;
      const inner = clone.tagName === 'mxCell' ? clone : clone.getElementsByTagName('mxCell')[0]!;
      clone.setAttribute('id', `${prefix}-${cell.id}`);
      const parent = cell.parent;
      inner.setAttribute('parent', parent === '1' ? '1' : `${prefix}-${parent}`);
      for (const terminal of ['source', 'target'] as const) {
        const value = cell[terminal];
        if (value) inner.setAttribute(terminal, `${prefix}-${value}`);
      }
      if (cell.id === entry.root.id) {
        if (options.source) inner.setAttribute('source', options.source);
        if (options.target) inner.setAttribute('target', options.target);
      }
      if (title === 'Title Block') {
        if (options.omitContainerName && clone.hasAttribute('label')) {
          clone.setAttribute('label', (clone.getAttribute('label') ?? '').replace('_%ContainerName%', ''));
          clone.removeAttribute('ContainerName');
        }
        const geometry = inner.getElementsByTagName('mxGeometry')[0];
        const width = Number(geometry?.getAttribute('width'));
        if (geometry && options.titleWidthDelta && width >= referenceWidth - 20 && width > referenceWidth / 2) {
          geometry.setAttribute('width', String(width + options.titleWidthDelta));
        }
        if (options.titleFilled && clone.hasAttribute('label')) {
          const label = clone.getAttribute('label') ?? '';
          for (const match of label.matchAll(/%([A-Za-z][A-Za-z0-9_]*)%/g)) {
            const key = match[1]!;
            clone.setAttribute(key, `${key} filled`);
          }
        }
      }
      this.root.appendChild(clone);
    }
    return `${prefix}-${entry.root.id}`;
  }

  cell(id: string): Element {
    const wrappers = Array.from(this.root.childNodes).filter(node => node.nodeType === 1) as Element[];
    const wrapper = wrappers.find(node => node.getAttribute('id') === id)!;
    return wrapper.tagName === 'mxCell' ? wrapper : wrapper.getElementsByTagName('mxCell')[0]!;
  }

  addRaw(xml: string): void {
    this.root.appendChild(parseXml(xml).documentElement!);
  }

  xml(): string {
    return serializer.serializeToString(this.document);
  }

  compressedXml(): string {
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(this.xml()), 'utf8')).toString('base64');
    return `<mxfile><diagram id="page-1">${compressed}</diagram></mxfile>`;
  }
}

function validContext(): DiagramFixture {
  const fixture = new DiagramFixture('c4-context');
  fixture.add('Key', 'key');
  fixture.add('Title Block', 'title', { titleFilled: true });
  fixture.add('Person', 'person');
  fixture.add('System', 'system');
  fixture.add('Arrow', 'arrow', { source: 'person-2', target: 'system-2' });
  return fixture;
}

function codes(type: string, xml: string): string[] {
  return evaluateDiagram(registry, type, xml).findings.map(item => item.code);
}

test('loads both library types', () => {
  assert.deepEqual([...registry.types.keys()], ['c4-context', 'c4-container']);
  assert.equal(registry.types.get('c4-context')!.entries.length, 8);
  assert.equal(registry.types.get('c4-container')!.entries.length, 15);
});

test('accepts a valid context diagram and compressed page', () => {
  const fixture = validContext();
  const result = evaluateDiagram(registry, 'c4-context', fixture.xml());
  assert.deepEqual(result.summary, {
    passed_checks: ['Diagram parsed', 'One diagram page', 'One intact Key', 'One intact Title Block with filled metadata',
      'Library shapes conform', 'Connector appearance conforms', 'Connector connections conform', 'No duplicate focus entry'],
    error_count: 0, warning_count: 0,
  });
  assert.deepEqual(codes('c4-context', fixture.xml()), []);
  assert.deepEqual(codes('c4-context', `<mxfile><diagram id="page-1">${fixture.xml()}</diagram></mxfile>`), []);
  assert.deepEqual(codes('c4-context', fixture.compressedXml()), []);
});

test('ordinary-shape label policy can be relaxed without relaxing required blocks', () => {
  const fixture = validContext();
  const wrapper = fixture.cell('system-2').parentNode as Element;
  wrapper.setAttribute('label', '<b>Custom label</b>');
  const graph = registry.types.get('c4-context')!.entries.find(entry => entry.title === 'System')!;
  const parsed = parseXml(fixture.xml()).documentElement!;
  const actual = parseGraph(parsed).byId.get('system-2')!;
  assert.equal(matchSingle(graph, actual, 'fixed'), false);
  assert.equal(matchSingle(graph, actual, 'unrestricted'), true);
});

test('accepts a valid container diagram with multiple blue container variants', () => {
  const fixture = new DiagramFixture('c4-container');
  fixture.add('Key', 'key');
  fixture.add('Title Block', 'title', { titleFilled: true });
  fixture.add('Container', 'one');
  fixture.add('Container', 'two');
  fixture.add('Database Container', 'database');
  fixture.add('Label - New', 'new-label');
  assert.deepEqual(codes('c4-container', fixture.xml()), []);
});

test('accepts resized boundaries, inert editor styles, and an organizational group', () => {
  const fixture = new DiagramFixture('c4-container');
  fixture.add('Key', 'key');
  fixture.add('Title Block', 'title', { titleFilled: true });
  const boundary = fixture.add('System Boundary', 'boundary');
  fixture.cell(boundary).getElementsByTagName('mxGeometry')[0]!.setAttribute('width', '320');
  fixture.cell(boundary).getElementsByTagName('mxGeometry')[0]!.setAttribute('height', '280');
  fixture.addRaw('<mxCell id="group" parent="1" vertex="1" style="group"><mxGeometry as="geometry" width="320" height="240"/></mxCell>');
  const external = fixture.add('External System', 'external');
  fixture.cell(external).setAttribute('parent', 'group');
  const shape = fixture.cell(external);
  shape.setAttribute('style', `${shape.getAttribute('style')}imageAspect=0;imageWidth=10;imageHeight=10;resizeWidth=1;resizeHeight=1;collapsible=0;`);
  assert.deepEqual(codes('c4-container', fixture.xml()), []);

  shape.setAttribute('style', `${shape.getAttribute('style')}fillColor=#ff0000;`);
  assert.ok(codes('c4-container', fixture.xml()).includes('MODIFIED_LIBRARY_SHAPE'));
});

test('allows synchronized Title Block width changes', () => {
  for (const delta of [-100, 250]) {
    const fixture = new DiagramFixture('c4-context');
    fixture.add('Key', 'key');
    fixture.add('Title Block', 'title', { titleFilled: true, titleWidthDelta: delta });
    assert.deepEqual(codes('c4-context', fixture.xml()), []);
  }
});

test('rejects changed Title Block height and internal alignment', () => {
  const fixture = validContext();
  fixture.cell('title-2').getElementsByTagName('mxGeometry')[0]!.setAttribute('height', '41');
  const first = evaluateDiagram(registry, 'c4-context', fixture.xml());
  assert.ok(first.findings.some(item => item.code === 'MISSING_TITLE_BLOCK'));
  assert.ok(!first.findings.some(item => item.code === 'FOREIGN_SHAPE'));
  const second = validContext();
  second.cell('title-3').getElementsByTagName('mxGeometry')[0]!.setAttribute('x', '21');
  assert.ok(codes('c4-context', second.xml()).includes('MISSING_TITLE_BLOCK'));
});

test('rejects an unsynchronized Title Block width change', () => {
  const fixture = validContext();
  fixture.cell('title-2').getElementsByTagName('mxGeometry')[0]!.setAttribute('width', '650');
  assert.ok(codes('c4-context', fixture.xml()).includes('MISSING_TITLE_BLOCK'));
});

test('requires the key and filled title fields', () => {
  const fixture = new DiagramFixture('c4-context');
  fixture.add('Title Block', 'title');
  const found = codes('c4-context', fixture.xml());
  assert.ok(found.includes('MISSING_KEY'));
  assert.equal(found.filter(code => code === 'TITLE_FIELD_UNFILLED').length, 3);
});

test('accepts a container title without ContainerName and a legitimate sample role', () => {
  const fixture = new DiagramFixture('c4-container');
  fixture.add('Key', 'key');
  fixture.add('Title Block', 'title', { titleFilled: true, omitContainerName: true });
  const title = fixture.cell('title-5').parentNode as Element;
  title.setAttribute('AuthorTitle', 'Systems Architect');
  assert.deepEqual(codes('c4-container', fixture.xml()), []);

  title.setAttribute('AuthorTitle', '');
  assert.ok(codes('c4-container', fixture.xml()).includes('TITLE_FIELD_UNFILLED'));
  title.setAttribute('AuthorTitle', 'Systems Architect');
  title.setAttribute('label', (title.getAttribute('label') ?? '').replace('Container Diagram', 'Other Diagram'));
  assert.ok(codes('c4-container', fixture.xml()).includes('MISSING_TITLE_BLOCK'));
});

test('rejects a modified key group', () => {
  const fixture = validContext();
  fixture.cell('key-4').setAttribute('style', 'fillColor=#000000;');
  const key = evaluateDiagram(registry, 'c4-context', fixture.xml()).findings.find(item => item.code === 'MISSING_KEY')!;
  assert.deepEqual(key.cell_ids, ['key-2']);
  assert.equal(key.expected_library_entry, 'Key');
  assert.equal(key.elements[0]?.geometry?.width, 780);
  assert.ok(key.elements.some(element => element.cell_id === 'key-4'));
  assert.ok(key.differences?.some(item => item.cell_id === 'key-4' && item.property === 'style.fillColor'));
  assert.ok(!evaluateDiagram(registry, 'c4-context', fixture.xml()).findings.some(item => item.code === 'FOREIGN_SHAPE'));
});

test('rejects resized and restyled library shapes', () => {
  const fixture = validContext();
  fixture.cell('system-2').getElementsByTagName('mxGeometry')[0]!.setAttribute('width', '260');
  assert.ok(codes('c4-context', fixture.xml()).includes('MODIFIED_LIBRARY_SHAPE'));
  const second = validContext();
  second.cell('system-2').setAttribute('style', 'rounded=1;fillColor=#ff0000;metaEdit=1;');
  (second.cell('system-2').parentNode as Element).setAttribute('c4Name', 'Payroll System');
  const changed = evaluateDiagram(registry, 'c4-context', second.xml()).findings.find(item => item.code === 'MODIFIED_LIBRARY_SHAPE')!;
  assert.equal(changed.expected_library_entry, 'System');
  assert.equal(changed.elements[0]?.name, 'Payroll System');
  assert.ok(changed.differences?.some(item => item.property === 'style.fillColor' && item.actual === '#ff0000'));
});

test('accepts shape metadata edits but rejects label markup edits', () => {
  const fixture = validContext();
  const wrapper = fixture.cell('system-2').parentNode as Element;
  wrapper.setAttribute('c4Name', 'New system name');
  assert.deepEqual(codes('c4-context', fixture.xml()), []);
  wrapper.setAttribute('label', '<b>Different markup</b>');
  assert.ok(codes('c4-context', fixture.xml()).includes('MODIFIED_LIBRARY_SHAPE'));
});

test('allows ordinary shape font sizes but keeps Key and Title Block fonts strict', () => {
  const fixture = validContext();
  const system = fixture.cell('system-2');
  system.setAttribute('style', `${system.getAttribute('style')}fontSize=24;`);
  const wrapper = system.parentNode as Element;
  wrapper.setAttribute('label', (wrapper.getAttribute('label') ?? '').replace('font-size: 16px', 'font-size: 24px'));
  assert.deepEqual(codes('c4-context', fixture.xml()), []);

  fixture.cell('key-4').setAttribute('style', `${fixture.cell('key-4').getAttribute('style')}fontSize=24;`);
  assert.ok(codes('c4-context', fixture.xml()).includes('MISSING_KEY'));
  const title = validContext();
  title.cell('title-5').setAttribute('style', `${title.cell('title-5').getAttribute('style')}fontSize=24;`);
  assert.ok(codes('c4-context', title.xml()).includes('MISSING_TITLE_BLOCK'));
});

test('warns for foreign shapes and images but accepts text', () => {
  const fixture = validContext();
  fixture.addRaw('<mxCell id="foreign" parent="1" vertex="1" style="shape=triangle;fillColor=#00ff00;"><mxGeometry width="60" height="60" as="geometry"/></mxCell>');
  fixture.addRaw('<mxCell id="image" parent="1" vertex="1" style="shape=image;image=data:image/png,abcd;"><mxGeometry width="40" height="40" as="geometry"/></mxCell>');
  fixture.addRaw('<mxCell id="text" parent="1" vertex="1" style="text;html=1;" value="note"><mxGeometry width="80" height="20" as="geometry"/></mxCell>');
  const result = evaluateDiagram(registry, 'c4-context', fixture.xml());
  assert.equal(result.valid, true);
  assert.equal(result.findings.filter(item => item.code === 'FOREIGN_SHAPE').length, 2);
});

test('warns for repeated context systems but not the example in the key', () => {
  const one = validContext();
  assert.ok(!codes('c4-context', one.xml()).includes('DUPLICATE_ENTRY'));
  one.add('System', 'system-two');
  const result = evaluateDiagram(registry, 'c4-context', one.xml());
  assert.equal(result.valid, true);
  assert.ok(result.findings.some(item => item.code === 'DUPLICATE_ENTRY'));
});

test('rejects nonstandard, two-headed, and opposite-direction arrows', () => {
  const fixture = validContext();
  fixture.cell('arrow-2').setAttribute('style', `${fixture.cell('arrow-2').getAttribute('style')}startArrow=blockThin;`);
  const first = codes('c4-context', fixture.xml());
  assert.ok(first.includes('TWO_HEADED_ARROW'));
  assert.ok(!first.includes('NONSTANDARD_CONNECTOR'));
  const second = validContext();
  second.add('Arrow', 'reverse', { source: 'system-2', target: 'person-2' });
  assert.ok(codes('c4-context', second.xml()).includes('BIDIRECTIONAL_CONNECTION'));
});

test('connector findings identify the relationship and both endpoints', () => {
  const fixture = validContext();
  (fixture.cell('person-2').parentNode as Element).setAttribute('c4Name', 'Alice');
  (fixture.cell('system-2').parentNode as Element).setAttribute('c4Name', 'Payroll');
  (fixture.cell('arrow-2').parentNode as Element).setAttribute('c4Description', 'Sends data');
  fixture.cell('arrow-2').setAttribute('style', `${fixture.cell('arrow-2').getAttribute('style')}strokeColor=#ff0000;`);
  const connector = evaluateDiagram(registry, 'c4-context', fixture.xml()).findings.find(item => item.code === 'NONSTANDARD_CONNECTOR')!;
  assert.equal(connector.elements[0]?.name, 'Sends data');
  assert.equal(connector.elements[0]?.source_name, 'Alice');
  assert.equal(connector.elements[0]?.target_name, 'Payroll');
  assert.equal(connector.expected_library_entry, 'Arrow');
});

test('accepts draw.io connector attachment coordinates without relaxing Arrow style', () => {
  const fixture = validContext();
  const arrow = fixture.cell('arrow-2');
  arrow.setAttribute('style', `${arrow.getAttribute('style')}entryX=0.5;entryY=0;entryDx=0;entryDy=0;entryPerimeter=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;exitPerimeter=0;`);
  assert.deepEqual(codes('c4-context', fixture.xml()), []);
  arrow.setAttribute('style', `${arrow.getAttribute('style')}strokeColor=#ff0000;`);
  assert.ok(codes('c4-context', fixture.xml()).includes('NONSTANDARD_CONNECTOR'));
});

test('allows connector labels and routing styles while checking line and arrowhead appearance', () => {
  const fixture = validContext();
  const arrow = fixture.cell('arrow-2');
  arrow.setAttribute('style', `${arrow.getAttribute('style')}edgeStyle=elbowEdgeStyle;fontSize=18;entryX=0.5;startSize=22;`);
  (arrow.parentNode as Element).setAttribute('label', '<b>Custom relationship</b>');
  assert.deepEqual(codes('c4-context', fixture.xml()), []);

  for (const [property, value] of [['strokeWidth', '2'], ['strokeColor', '#ff0000'],
    ['endArrow', 'classic'], ['endFill', '0'], ['endSize', '20']] as const) {
    const changed = validContext();
    changed.cell('arrow-2').setAttribute('style', `${changed.cell('arrow-2').getAttribute('style')}${property}=${value};`);
    const finding = evaluateDiagram(registry, 'c4-context', changed.xml()).findings.find(item => item.code === 'NONSTANDARD_CONNECTOR');
    assert.ok(finding?.differences?.some(item => item.property === `style.${property}`), property);
  }
});

test('rejects an edge endpoint that cannot be evaluated', () => {
  const fixture = validContext();
  fixture.cell('arrow-2').setAttribute('target', 'missing-shape');
  assert.ok(codes('c4-context', fixture.xml()).includes('INVALID_CONNECTION_ENDPOINT'));
});

test('rejects malformed input and mxfiles without pages', () => {
  assert.deepEqual(codes('c4-context', '<mxfile>'), ['MALFORMED_XML']);
  assert.deepEqual(codes('c4-context', '<mxfile/>'), ['MALFORMED_XML']);
  assert.deepEqual(codes('missing', validContext().xml()), ['UNKNOWN_DIAGRAM_TYPE']);
  assert.deepEqual(evaluateDiagram(registry, 'c4-context', '<mxfile>').summary.passed_checks, []);
});

test('warns about multiple pages and evaluates only the first page', () => {
  const validPage = validContext().xml();
  const emptyPage = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const firstValid = evaluateDiagram(registry, 'c4-context',
    `<mxfile><diagram id="first">${validPage}</diagram><diagram id="second">${emptyPage}</diagram></mxfile>`);
  assert.equal(firstValid.valid, true);
  assert.deepEqual(firstValid.findings.map(item => [item.severity, item.code]), [['warning', 'MULTI_PAGE']]);
  assert.match(firstValid.findings[0]!.message, /later pages were not evaluated/);
  assert.equal(firstValid.summary.warning_count, 1);
  assert.ok(!firstValid.summary.passed_checks.includes('One diagram page'));

  const firstInvalid = evaluateDiagram(registry, 'c4-context',
    `<mxfile><diagram id="first">${emptyPage}</diagram><diagram id="second">${validPage}</diagram></mxfile>`);
  assert.equal(firstInvalid.valid, false);
  assert.deepEqual(firstInvalid.findings.map(item => item.code), ['MISSING_KEY', 'MISSING_TITLE_BLOCK', 'MULTI_PAGE']);

  const compressedFirst = validContext().compressedXml().replace('</mxfile>',
    `<diagram id="second">${emptyPage}</diagram></mxfile>`);
  assert.deepEqual(codes('c4-context', compressedFirst), ['MULTI_PAGE']);

  const malformedFirst = evaluateDiagram(registry, 'c4-context',
    `<mxfile><diagram>invalid-base64!</diagram><diagram>${validPage}</diagram></mxfile>`);
  assert.deepEqual(malformedFirst.findings.map(item => [item.severity, item.code]),
    [['error', 'MALFORMED_XML'], ['warning', 'MULTI_PAGE']]);
});

test('rejects DOCTYPE and ENTITY declarations as unsafe XML', () => {
  for (const declaration of ['<!DOCTYPE mxGraphModel>', '<!ENTITY test "value">']) {
    assert.deepEqual(codes('c4-context', `${declaration}<mxGraphModel><root/></mxGraphModel>`), ['UNSAFE_XML']);
  }
});

test('rejects a compressed page that inflates beyond 20 MiB', () => {
  const oversized = `<mxGraphModel><root>${'x'.repeat(20 * 1024 * 1024)}</root></mxGraphModel>`;
  const compressed = deflateRawSync(Buffer.from(encodeURIComponent(oversized))).toString('base64');
  const result = evaluateDiagram(registry, 'c4-context', `<mxfile><diagram>${compressed}</diagram></mxfile>`);
  assert.equal(result.valid, false);
  assert.deepEqual(result.findings.map(item => item.code), ['MALFORMED_XML']);
});

test('rejects nesting deeper than MAX_DEPTH', () => {
  const nested = Array.from({ length: MAX_DEPTH + 1 }, (_, index) =>
    `<mxCell id="nested-${index}" parent="${index ? `nested-${index - 1}` : '1'}" vertex="1"/>`).join('');
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${nested}</root></mxGraphModel>`;
  assert.deepEqual(codes('c4-context', xml), ['TOO_DEEP']);
});

test('warns about an arrow without a source or target while keeping the diagram valid', () => {
  for (const endpoint of ['source', 'target']) {
    const fixture = validContext();
    fixture.cell('arrow-2').removeAttribute(endpoint);
    const result = evaluateDiagram(registry, 'c4-context', fixture.xml());
    const issue = result.findings.find(item => item.code === 'UNCONNECTED_CONNECTOR');
    assert.equal(issue?.severity, 'warning');
    assert.equal(issue?.expected_library_entry, 'Arrow');
    assert.deepEqual(issue?.cell_ids, ['arrow-2']);
    assert.equal(result.valid, true);
    assert.equal(result.summary.error_count, 0);
    assert.equal(result.summary.warning_count, 1);
    assert.ok(!result.summary.passed_checks.includes('Connector connections conform'));
  }
});

test('accepts font-size markup around part of a library shape label', () => {
  const fixture = validContext();
  const wrapper = fixture.cell('system-2').parentNode as Element;
  wrapper.setAttribute('label', (wrapper.getAttribute('label') ?? '')
    .replace('%c4Name%', '%c4<font style="font-size: 18px;">Name</font>%'));
  assert.deepEqual(codes('c4-context', fixture.xml()), []);
});

test('uses the default end arrow when its style key is removed', () => {
  const fixture = validContext();
  const arrow = fixture.cell('arrow-2');
  arrow.setAttribute('style', (arrow.getAttribute('style') ?? '').replace(/endArrow=[^;]*;/, ''));
  const result = evaluateDiagram(registry, 'c4-context', fixture.xml());
  const difference = result.findings.find(item => item.code === 'NONSTANDARD_CONNECTOR')?.differences
    ?.find(item => item.property === 'style.endArrow');
  assert.equal(difference?.actual, 'classic');

  arrow.setAttribute('style', `${arrow.getAttribute('style')}startArrow=classic;`);
  const twoHeaded = evaluateDiagram(registry, 'c4-context', fixture.xml());
  assert.ok(twoHeaded.findings.some(item => item.code === 'TWO_HEADED_ARROW'));
  const nonstandard = twoHeaded.findings.find(item => item.code === 'NONSTANDARD_CONNECTOR');
  assert.ok(nonstandard);
  assert.ok(!nonstandard.differences?.some(item => item.property === 'style.startArrow'));
});

test('accepts the default connector stroke width', () => {
  const fixture = validContext();
  const arrow = fixture.cell('arrow-2');
  arrow.setAttribute('style', (arrow.getAttribute('style') ?? '').replace(/strokeWidth=[^;]*;/, ''));
  assert.deepEqual(codes('c4-context', fixture.xml()), []);
});

test('allows opposing arrows when forbidBidirectional is false', () => {
  const fixture = validContext();
  fixture.add('Arrow', 'reverse', { source: 'system-2', target: 'person-2' });
  const localRegistry = new TypeRegistry();
  localRegistry.types.get('c4-context')!.config.forbidBidirectional = false;
  assert.deepEqual(evaluateDiagram(localRegistry, 'c4-context', fixture.xml()).findings, []);
});
