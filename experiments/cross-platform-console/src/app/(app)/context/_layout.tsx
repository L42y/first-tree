import { Stack } from "expo-router";
import { nativeHeaderOptions } from "~/lib/native-header";

export default function ContextStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ ...nativeHeaderOptions, title: "Context" }} />
    </Stack>
  );
}
