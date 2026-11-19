# Solid Studio local API

Responses are JSON. Mutations require `X-Solid-Studio: 1` and `Content-Type: application/json`. Browser cross-site mutation requests are rejected. This is a trusted-LAN app, not an authenticated multi-user service.

| Method / path | Body | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{ok,service,version,bundle}` |
| `GET /api/settings` | — | `{version,layerLibraryUrl}` |
| `PUT /api/settings` | `{layerLibraryUrl}` | Updated settings |
| `GET /api/projects` | — | `{projects:[summary...]}` |
| `POST /api/projects` | `{project:document}` | HTTP201 `{project:record}` |
| `GET /api/projects/:id` | — | `{project:record}` |
| `PUT /api/projects/:id` | `{project:document,expectedRevision:integer}` | `{project:record}` |
| `DELETE /api/projects/:id` | `{expectedRevision:integer}` | `{ok:true}` |
| `POST /api/library/test` | `{}` | `{ok,message,version}` |
| `POST /api/library/export` | `{name,project:document,stlBase64,requestId:UUID,expectedLibraryUrl?:string}` | `{ok,requestId,modelId,url,reused,projectIncluded,message,warning?}` |

A project **document** has `format: "solid-studio"`, `version: 1`, a name, an array of objects and settings. It is stored unchanged. A **record** wraps it as `{id,name,document,revision,createdAt,updatedAt,objectCount}`. A list summary omits the document. Save the returned server ID and revision separately from the portable document. Updating/deleting requires the most recent revision: a stale or absent revision returns409 rather than overwriting another device's edit. HTTP success is sent after the SQLite transaction commits.

Delete hides the project from the active list and retains its row in the database. There is no public trash/restore UI in version 1.2. Export project JSON before deleting if you need a portable recovery copy.

Versions 1.1 and 1.2 keep the same project format/version. Capsule parameters may include `topRoundness` and `bottomRoundness`, each from 0 to 2; absent values use the original roundness of 1. Nodes may also contain `clipPlanes: [{normal: [x,y,z], offset: d}]`. A plane normal is normalized by the geometry engine; its offset is the signed distance along that normalized normal. A plane keeps local points where `dot(normalize(normal), point) >= d`, after the node's primitive/Boolean calculation and before its transform. At most 32 planes are accepted per node, with finite nonzero normals and bounded offsets. These fields survive saves and editable project downloads.

Centred fitting in version 1.2 uses the existing object transforms and Boolean tree. A loose hole can be moved into a body cut group, or hidden when it has no host body, so it does not subtract the fitted insert. This needs no database migration or extra project-format fields.

Use a fresh UUID for a genuinely new Layer Library transfer and retain that same ID when retrying the same bytes and metadata. Reusing it for another model returns409. A confirmed repeat returns the cached receipt without another upload. An uncertain transfer returns an error with `uncertain:true`, requiring inspection of Layer Library before deliberately beginning a new transfer. Omitting `requestId` generates one, but callers should supply and persist it so retries are safe.

Supply `expectedLibraryUrl` to bind a new transfer to the destination shown when the export was prepared. The server normalizes it and returns409 before uploading if the saved destination has since changed. Transfer receipts also bind to the destination, so changing the configured library cannot silently redirect a retry.

Errors return `{"error":"human-readable message",...}` with an appropriate non-2xx status. JSON size limits apply before parsing. Imported mesh coordinates and index arrays are validated when saved; the browser geometry engine additionally checks whether they represent valid closed solids before boolean/export operations.
