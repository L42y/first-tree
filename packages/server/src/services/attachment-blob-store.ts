import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NotFoundError, ServiceUnavailableError } from "../errors.js";

export interface AttachmentBlobStore {
  put(key: string, body: Readable, contentLength?: number): Promise<void>;
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
    async put(key, body, contentLength) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
        }),
      );
    },

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

/**
 * Tests inject this store so route and service tests exercise the same
 * streaming contract without requiring a networked object-store container.
 */
export class MemoryAttachmentBlobStore implements AttachmentBlobStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

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
      "Object storage is not configured. Set FIRST_TREE_OBJECT_STORAGE_BUCKET and related settings.",
    );
  };
  return {
    put: unavailable,
    get: unavailable,
    delete: unavailable,
  };
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return record.name === "NoSuchKey" || record.name === "NotFound" || record.$metadata?.httpStatusCode === 404;
}
