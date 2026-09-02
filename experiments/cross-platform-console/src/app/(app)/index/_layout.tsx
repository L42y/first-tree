import { Stack } from "expo-router";
import { QuickActionsButton } from "~/components/quick-actions";
import { TeamSwitcher } from "~/components/team-switcher";
import { nativeHeaderOptions } from "~/lib/native-header";

/**
 * Own native stack for the Chats tab so it gets a real large title that
 * collapses to a small centered one on scroll, like Apple's own apps —
 * NativeTabs itself has no opinion about headers, this is what supplies one.
 */
export default function ChatsStackLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="chats"
        options={{
          ...nativeHeaderOptions,
          title: "Chats",
          headerLeft: () => <TeamSwitcher />,
          headerRight: () => <QuickActionsButton />,
        }}
      />
    </Stack>
  );
}
