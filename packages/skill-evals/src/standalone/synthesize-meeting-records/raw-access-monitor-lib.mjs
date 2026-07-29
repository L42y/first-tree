export function isProtectedPathMutation(eventType, filename, protectedName) {
  if (eventType !== "rename" && eventType !== "change") return false;
  if (filename === null || filename === undefined) return true;
  return filename.toString() === protectedName;
}
