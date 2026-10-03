# Diagram evaluator MCP server

This server checks one editable draw.io diagram against the selected exported shape library. It ships with `c4-context` and `c4-container`, using the files in `Libraries/` as the source of truth. Evaluation is deterministic and does not render the diagram or call an AI model.

## Run

Requires Node.js 20 or newer.

```powershell
npm ci
npm run build
npm start
```

`npm start` speaks MCP over stdio; diagnostics go to stderr. For local Streamable HTTP:

```powershell
npm run start:http -- --port 3000
```

The endpoint is `http://127.0.0.1:3000/mcp`. It binds only to loopback and validates the Host and Origin headers. The port defaults to 3000, or to `PORT` when set. To run from an MCP client, configure it to launch `node` with the absolute path to `dist/src/server.js` and set its working directory to this project. The server locates its configuration relative to its compiled code, so the working directory is not needed for library lookup.

## Tools

- `list_diagram_types()` lists type IDs, library entry names, and label policy.
- `evaluate_diagram({ "diagram_type": "c4-context", "diagram_xml": "<mxGraphModel>...</mxGraphModel>" })` accepts inline, editable draw.io XML. It supports a standalone `<mxGraphModel>` or an `<mxfile>` with compressed or uncompressed `<diagram>` pages. If an `<mxfile>` has multiple pages, the tool evaluates the first and emits a `MULTI_PAGE` warning; later pages are not evaluated. It does not accept image-only exports.

The tool advertises this output schema and returns it in both MCP `structuredContent` and JSON text:

```json
{
  "diagram_type": "c4-context",
  "valid": false,
  "summary": {
    "passed_checks": ["Diagram parsed", "One diagram page", "One intact Key", "One intact Title Block with filled metadata"],
    "error_count": 1,
    "warning_count": 0
  },
  "findings": [
    {
      "severity": "error",
      "code": "MODIFIED_LIBRARY_SHAPE",
      "message": "Cell resembles a library shape but differs in style, size, or label template.",
      "cell_ids": ["shape-17"],
      "elements": [{ "cell_id": "shape-17", "kind": "rectangle", "name": "Payroll", "type": "Software System", "parent_id": "group-2" }],
      "expected_library_entry": "External System",
      "differences": [{ "property": "style.fillColor", "expected": "#8C8496", "actual": "#ff0000" }]
    }
  ]
}
```

The `summary` lists checks that completed without findings before the detailed failures and warnings, plus counts for each severity. It lists no passed checks when the diagram type is unknown or input cannot be fully evaluated. The `findings` array contains every issue detected by the configured rules, with one entry per finding. `elements` gives the cell ID, readable name and type when available, parent ID, geometry, and connector endpoint IDs and names. Geometry coordinates may be relative to the parent group. `expected_library_entry` and `differences` identify the closest library template and mismatched properties when possible. `cell_ids` is deprecated in favor of `elements`. An error makes `valid` false; warnings alone keep it true. Malformed input and unknown types are returned as evaluation findings so callers receive the same result shape; malformed XML cannot be checked further.

## Rules

The selected library must contain exactly one intact `Key` and `Title Block`, including their child cells. Their styles, heights, and internal layout must match. Key labels are fixed; Title Block labels may omit configured optional fields. Placement and regenerated IDs are allowed. The Title Block's outer group, horizontal background, and text cell may change width together; its narrow accent keeps its library width. Every metadata field referenced by the actual title label must be nonblank. Fields matching the library sample are rejected unless configured to allow that sample value.

Ordinary library shapes must retain their visual style and embedded image or stencil content, except that font sizes may change in the cell style or HTML label. Their width and height may change unless the library style explicitly sets `resizable=0`. Placement, IDs, and metadata values may change. Editor-only style keys on shapes without images are ignored. Other label markup is fixed by default. Key and Title Block font sizes remain strict. Standalone text labels and unstyled groups used to organize child cells are accepted. Clearly foreign shapes and images produce warnings; cells retaining C4 metadata or the library's `metaEdit` marker while differing from a template produce errors. XML does not carry a trustworthy provenance marker, so a shape stripped of all identifying data may be indistinguishable from a foreign shape.

Connectors must match the library `Arrow` stroke width, stroke color, and arrowhead style (head type, fill, and size). Their labels, other styles, endpoints, and routing may change. A connector without a source or target produces a warning. A connector with arrowheads at both ends, or a pair of opposing A→B and B→A connectors, is an error. The arrow inside the intact Key is excluded. On `c4-context`, more than one matching blue `System` in the diagram body produces a warning; blue Container entries do not trigger that rule.

## Add a diagram type

Place an exported `<mxlibrary>` file in `Libraries/` and add a type entry to `diagram-types.json`. Its library must have entries titled `Key`, `Title Block`, and `Arrow`. Each entry needs one root cell; group multi-cell entries in draw.io before exporting. The remaining entries become allowed shapes. Restart the server after changing the configuration or library.

Configuration fields:

- `library`: path relative to this project.
- `labelPolicy`: `fixed` (default) or `unrestricted` for ordinary shapes. Key and Title Block labels stay fixed.
- `titleStretchIds`: IDs in the **library's** Title Block entry whose widths change by the same amount. The supplied C4 types use `2` (outer group), `3` (background), and `5` (text).
- `optionalTitleFields`: fields whose preceding underscore and placeholder may be omitted from the Title Block label. `c4-container` allows `ContainerName` to be omitted.
- `titleSampleAllowedFields`: fields for which the library sample is also a legitimate final value. The supplied C4 types allow `AuthorTitle`.
- `warnOnDuplicateEntry`: optional library entry title for a warning when more than one matching instance occurs outside the Key.
- `forbidBidirectional`: reject opposing arrows between the same two shapes (default `true`).
- `forbidTwoHeaded`: reject arrows with arrowheads at both ends (default `true`).

**Breaking change:** the duplicate-entry warning code is now `DUPLICATE_ENTRY` instead of `DUPLICATE_FOCUS_SYSTEM`.

Run `npm test` to build and check validation and both MCP transports.

Run `npm run examples` to evaluate every `.drawio` file in a local `Examples/` directory. Example diagrams and generated `example-mcp-findings` reports are excluded from Git. The command prints a finding summary per file and exits with status 1 if any diagram has errors. Use `npm run examples -- --json` for full findings and cell IDs. The diagram type is inferred from `Context` or `Container` in each filename; use `--type <id>` to override it. `npm run report:examples -- --type <id>` accepts the same override.
