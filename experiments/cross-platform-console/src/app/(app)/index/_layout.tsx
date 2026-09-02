import { Stack } from "expo-router";
import { nativeHeaderOptions } from "~/lib/native-header";

/**
 * Own stack for the Chats tab (needed to nest under NativeTabs at all) but
 * headerless — the large title lives in the screen itself, see
 * ~/components/collapsing-header.tsx.
 */
export default function ChatsStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ ...nativeHeaderOptions, title: "Chats" }} />
    </Stack>
  );
}
