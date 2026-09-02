/**
 * Every (app) tab's own Stack renders headerless — the large title and its
 * scroll collapse are hand-rolled (~/components/collapsing-header.tsx)
 * instead of the native headerLargeTitle, which doesn't track scroll
 * correctly when nested under NativeTabs on iOS (expo/expo#40717).
 */
export const nativeHeaderOptions = {
  headerShown: false,
} as const;
