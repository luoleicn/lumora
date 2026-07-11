# Mendeley sync coverage

Lumora uses the versioned Mendeley API media types and follows every `rel="next"`
pagination link. The current personal-library sync covers the Mendeley resources that
map to Lumora's research library:

| Mendeley resource | Officially available data/operations | Lumora mapping |
| --- | --- | --- |
| Documents | Full metadata (`view=all`), create, update, permanent delete, deleted-document feed | `Paper`, two-way |
| Folders | Name, parent hierarchy, create, move/rename, delete | `Collection`, two-way |
| Folder documents | Many-to-many folder membership, add and remove | `PaperCollection`, two-way |
| Files | Attachment id, owning document, filename, MIME type, SHA-1, byte size; upload/download/delete endpoints | `FileAsset`; remote content is downloaded and integrity metadata is retained |
| Annotations | Document notes, PDF highlights, sticky notes, RGB color, text, privacy, file hash, page/point boxes; create/update/delete and modified/deleted feeds | `Annotation`, two-way |
| Trash | Full trashed-document collection, move to trash, restore, permanent delete | Pulled into `Paper.deletedAt`; local deletion moves a linked document to Mendeley trash |

The original Mendeley annotation coordinates are retained alongside Lumora's display
coordinates. This prevents a Lumora-to-Mendeley round trip from replacing precise PDF
point boxes with approximations.

Mendeley also exposes profiles, groups, catalog/search/statistics, institutions,
disciplines, and research datasets. Those are valid API resources, but they are not
personal-library state represented by Lumora's current domain model and therefore are
not included in this sync. Group-owned folders/documents/annotations require an
explicit group UX and conflict policy and are likewise not silently merged into the
personal library.

Official references:

- [Core API resources](https://dev.mendeley.com/overview/core_resources.html)
- [Mendeley API methods](https://dev.mendeley.com/methods/)
- [Pagination](https://dev.mendeley.com/reference/topics/pagination.html)
- [API versioning](https://dev.mendeley.com/reference/topics/versioning.html)
- [OAuth authorization](https://dev.mendeley.com/reference/topics/authorization_overview.html)
