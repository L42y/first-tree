import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Paragraph, Text } from "tamagui";

export default function HomeScreen() {
  const [count, setCount] = useState(0);

  return (
    <View style={styles.container}>
      <Text fontSize="$8" fontWeight="bold" color="$color">
        First Tree
      </Text>
      <Paragraph style={{ textAlign: "center" }} color="$color11">
        Cross-platform console experiment.
        {"\n"}
        Expo + Tamagui targeting Web, iOS, Android, and macOS Catalyst.
      </Paragraph>
      <View style={styles.counter}>
        <Paragraph color="$color11">Taps: {count}</Paragraph>
        <Button onPress={() => setCount((c) => c + 1)}>Tap me</Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    gap: 16,
  },
  counter: {
    alignItems: "center",
    gap: 8,
  },
});
