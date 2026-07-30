import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NotFoundError, ServiceUnavailableError } from "../errors.js";

/**
 * Transitional access to payloads written by the short-lived S3-backed
 * implementation. New attachment writes never use this interface.
 */
export interface AttachmentBlobStore {
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export type S3AttachmentBlobStoreOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export function createS3AttachmentBlobStore(options: S3AttachmentBlobStoreOptions): AttachmentBlobStore {
  if (Boolean(options.accessKeyId) !== Boolean(options.secretAccessKey)) {
    throw new Error("Object storage access key id and secret access key must be configured together");
  }
  const credentials =
    options.accessKeyId && options.secretAccessKey
      ? {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
        }
      : undefined;
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
    ...(credentials ? { credentials } : {}),
  });

  return {
    async get(key) {
      try {
        const output = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
        if (!output.Body) throw new NotFoundError(`Attachment object "${key}" not found`);
        if (output.Body instanceof Readable) return output.Body;
        if (Symbol.asyncIterator in Object(output.Body)) {
          return Readable.from(output.Body as AsyncIterable<Uint8Array>);
        }
        throw new ServiceUnavailableError("Object storage returned an unsupported response body");
      } catch (error) {
        if (isS3NotFound(error)) throw new NotFoundError(`Attachment object "${key}" not found`);
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}

export class MemoryAttachmentBlobStore implements AttachmentBlobStore {
  readonly objects = new Map<string, Buffer>();

  async get(key: string): Promise<Readable> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new NotFoundError(`Attachment object "${key}" not found`);
    return Readable.from([bytes]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export function createUnavailableAttachmentBlobStore(): AttachmentBlobStore {
  const unavailable = () => {
    throw new ServiceUnavailableError(
      "Legacy object storage is not configured. Keep FIRST_TREE_OBJECT_STORAGE_BUCKET and related settings until the attachment reverse backfill completes.",
    );
  };
  return {
    get: unavailable,
    delete: unavailable,
  };
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return record.name === "NoSuchKey" || record.name === "NotFound" || record.$metadata?.httpStatusCode === 404;
}
