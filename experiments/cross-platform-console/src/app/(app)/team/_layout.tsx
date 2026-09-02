import { Stack, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import { nativeHeaderOptions } from "~/lib/native-header";
import { colors } from "~/lib/theme";

export default function TeamStackLayout() {
  const router = useRouter();
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{
          ...nativeHeaderOptions,
          title: "Team",
          headerRight: () => (
            <Pressable onPress={() => router.push("/agent/new")} hitSlop={8}>
              <Text style={styles.addButtonText}>+ New</Text>
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  addButtonText: {
    color: colors.accent,
    fontWeight: "700",
    fontSize: 15,
  },
});
