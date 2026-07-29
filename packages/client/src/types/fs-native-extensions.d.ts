declare module "fs-native-extensions" {
  export function tryLock(
    fileDescriptor: number,
    offset?: number,
    length?: number,
    options?: Readonly<{ shared?: boolean }>,
  ): boolean;

  export function unlock(fileDescriptor: number, offset?: number, length?: number): void;
}
