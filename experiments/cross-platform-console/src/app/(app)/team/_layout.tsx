import { Stack } from "expo-router";
import { nativeHeaderOptions } from "~/lib/native-header";

/**
 * Own stack for the Team tab (needed to nest under NativeTabs at all) but
 * headerless — the large title and the "+ New" button live in the screen
 * itself, see ~/components/collapsing-header.tsx.
 */
export default function TeamStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ ...nativeHeaderOptions, title: "Team" }} />
    </Stack>
  );
}
