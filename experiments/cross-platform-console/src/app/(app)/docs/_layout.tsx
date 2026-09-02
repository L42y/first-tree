import { Stack } from "expo-router";

/**
 * Options are set dynamically from within index.tsx: the large title only
 * makes sense for the doc list, not the reader view it swaps to locally.
 */
export default function DocsStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" />
    </Stack>
  );
}
