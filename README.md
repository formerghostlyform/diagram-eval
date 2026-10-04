# Diagram Evaluator MCP Server

![Diagram Evaluator MCP banner](img/banner.png)

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
  "evaluated_at": "2026-10-03T14:25:30.123Z",
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

`evaluated_at` is the UTC time when the evaluation completed, in ISO 8601 format. It is present on successful and failed evaluations. The `summary` lists checks that completed without findings before the detailed failures and warnings, plus counts for each severity. It lists no passed checks when the diagram type is unknown or input cannot be fully evaluated. The `findings` array contains every issue detected by the configured rules, with one entry per finding. `elements` gives the cell ID, readable name and type when available, parent ID, geometry, and connector endpoint IDs and names. Geometry coordinates may be relative to the parent group. `expected_library_entry` and `differences` identify the closest library template and mismatched properties when possible. `cell_ids` is deprecated in favor of `elements`. An error makes `valid` false; warnings alone keep it true. Malformed input and unknown types are returned as evaluation findings so callers receive the same result shape; malformed XML cannot be checked further.

## Rules

Use the library for the diagram type you are creating (`c4-context` or `c4-container`) and keep the diagram editable in draw.io. The evaluator checks the first page of an exported diagram; it warns if the file contains more pages.

1. **Include one Key and one Title Block.** Copy each as a complete group from the selected library. You can move them, but keep their child shapes, styles, fonts, heights, and internal layout intact. Keep the Key's labels unchanged. You may change the Title Block's width if its outer group, background, and text area stretch together; leave the narrow accent at its original width.
2. **Fill in the Title Block.** Give every field shown in its label a nonblank value, and replace the library's sample values. `AuthorTitle` may keep its sample value. For `c4-container`, you may omit the optional `ContainerName` field from the Title Block label.
3. **Build with library shapes.** You can move ordinary shapes, change their metadata values, and resize them unless the library shape is fixed size. You can change their font size, but keep their other styling, embedded images or stencils, and label template intact. Standalone text labels and plain groups for organizing shapes are allowed. Shapes or images outside the library produce warnings; changing a recognizable library shape's protected properties produces an error.
4. **Use the library Arrow for connections.** You can change an arrow's label, endpoints, and route, but keep its line width, color, and arrowhead style. Connect both ends to shapes. Do not use two arrowheads on one connector or draw opposing arrows between the same pair of shapes.

For `c4-context`, use at most one blue `System` shape in the diagram body; additional matching `System` shapes produce a warning. Warnings leave a diagram valid, while errors make it invalid.

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
