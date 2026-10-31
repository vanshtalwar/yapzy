import { type Prisma } from '@app/db';

export interface AuditEntry {
  adminId: string;
  /** e.g. `report.dismiss`, `ban.create`, `auth.login`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Always called inside the transaction of the change it records. */
export async function audit(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    },
  });
}
