import type { Prisma } from "@prisma/client";
import type { SyncEntity, SyncOperation } from "@lumora/shared";

type Transaction = Prisma.TransactionClient;

export async function recordChange(
  tx: Transaction,
  userId: string,
  entity: SyncEntity,
  entityId: string,
  op: SyncOperation,
  clientId?: string
) {
  return tx.change.create({
    data: {
      userId,
      entityType: entity,
      entityId,
      op,
      clientId
    }
  });
}
