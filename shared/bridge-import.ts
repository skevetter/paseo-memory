import { z } from "zod";
import { MemoryRefSchema } from "./lifecycle";
import { MemoryNamespaceSchema } from "./namespaces";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SourceIdSchema = z.string().regex(/^artifact:bridge-import-[a-f0-9]{64}$/);
const CountSchema = z.number().int().nonnegative();

export const BridgeImportPreviewInputSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).max(32),
  namespace: MemoryNamespaceSchema,
});
export type BridgeImportPreviewInput = z.infer<typeof BridgeImportPreviewInputSchema>;

export const BridgeImportInputSchema = z.strictObject({
  importId: z.string().min(1).max(200),
  previewToken: z.string().min(1).max(100000),
  approvedSourceIds: z.array(SourceIdSchema).max(128),
});
export type BridgeImportInput = z.infer<typeof BridgeImportInputSchema>;

export const BridgeImportPreviewSchema = z.strictObject({
  previewToken: z.string().min(1),
  namespace: MemoryNamespaceSchema,
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      sourceHash: Sha256Schema,
      bytes: CountSchema,
    }),
  ),
  candidates: z.array(
    z.strictObject({
      sourceId: SourceIdSchema,
      sourcePath: z.string().min(1),
      sourceHash: Sha256Schema,
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(4000),
      duplicate: MemoryRefSchema.nullable(),
    }),
  ),
  unsupported: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
  counts: z.strictObject({
    candidates: CountSchema,
    duplicates: CountSchema,
    unsupported: CountSchema,
  }),
});
export type BridgeImportPreview = z.infer<typeof BridgeImportPreviewSchema>;

export const BridgeImportResultSchema = z.strictObject({
  proposed: CountSchema,
  duplicates: CountSchema,
  memoryRefs: z.array(MemoryRefSchema),
  sourceIds: z.array(SourceIdSchema),
});
export type BridgeImportResult = z.infer<typeof BridgeImportResultSchema>;
