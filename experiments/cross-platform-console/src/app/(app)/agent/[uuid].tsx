import { useLocalSearchParams } from "expo-router";

import { AgentDetailContent } from "~/components/agent-detail";

/** Route wrapper — the UI lives in AgentDetailContent. */
export default function AgentDetailScreen() {
  const { uuid, provider } = useLocalSearchParams<{ uuid: string; provider?: string }>();
  return <AgentDetailContent uuid={uuid} provider={provider} />;
}
