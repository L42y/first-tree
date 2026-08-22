import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

/**
 * Quick-actions sheet — the experiment's command-palette stand-in: one
 * tappable list of navigation + session actions, reachable from the
 * Chats header on every surface.
 */
export function QuickActions({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { logout } = useAuth();

  const go = (path: string) => {
    onClose();
    router.push(path as never);
  };

  const items: Array<{ label: string; action: () => void; destructive?: boolean }> = [
    { label: "Start chat with an agent…", action: () => go("/team") },
    { label: "Archived chats", action: () => go("/") },
    { label: "Repositories", action: () => go("/repos") },
    { label: "Docs", action: () => go("/docs") },
    { label: "Context", action: () => go("/context") },
    { label: "Team", action: () => go("/team") },
    { label: "Settings", action: () => go("/settings") },
    { label: "Log out", action: () => void logout(), destructive: true },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Quick actions</Text>
          {items.map((item) => (
            <Pressable
              key={item.label}
              onPress={item.action}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Text style={[styles.itemLabel, item.destructive && styles.destructive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingVertical: 8,
  },
  title: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
  itemLabel: {
    color: colors.text,
    fontSize: 15,
  },
  destructive: {
    color: colors.danger,
    fontWeight: "600",
  },
});
