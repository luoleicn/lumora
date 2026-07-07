-- Add user-scoped unique selectors for entity writes. Existing global primary
-- keys remain in place; application writes now address records by (userId, id)
-- to avoid cross-user updates when client-provided entity ids collide.
CREATE UNIQUE INDEX "Paper_userId_id_key" ON "Paper"("userId", "id");
CREATE UNIQUE INDEX "FileAsset_userId_id_key" ON "FileAsset"("userId", "id");
CREATE UNIQUE INDEX "Collection_userId_id_key" ON "Collection"("userId", "id");
CREATE UNIQUE INDEX "PaperCollection_userId_id_key" ON "PaperCollection"("userId", "id");
CREATE UNIQUE INDEX "Annotation_userId_id_key" ON "Annotation"("userId", "id");
