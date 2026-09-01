import type { OrgBrief } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { useAuth } from "~/lib/auth-context";
import { listMyOrganizations } from "~/lib/team-api";
import { colors } from "~/lib/theme";

// Match the web switcher: don't let a very fast switch flash the transition
// veil for a single frame.
const MIN_SHOW_MS = 300;

/**
 * Mobile counterpart of the web team switcher. Switching updates the selected
 * org, clears every org-scoped React Query cache, returns to the workspace
 * root, and keeps a global transition veil up until `/me` settles.
 */
export function TeamSwitcher() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { organizationId, teamDisplayName, selectOrganization, switchingOrg, setSwitchingOrg } = useAuth();
  const [open, setOpen] = useState(false);
  const [errorOrgId, setErrorOrgId] = useState<string | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const orgsQuery = useQuery({
    queryKey: ["me", "organizations"],
    queryFn: ({ signal }) => listMyOrganizations(signal),
    enabled: !!organizationId,
  });
  const orgs = orgsQuery.data ?? [];

  useEffect(() => {
    if (open) return;
    setErrorOrgId(null);
  }, [open]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    };
  }, []);

  const switchTo = async (org: OrgBrief) => {
    if (switchingOrg || org.id === organizationId) {
      if (!switchingOrg) setOpen(false);
      return;
    }

    setErrorOrgId(null);
    setSwitchingOrg(org);
    const startedAt = Date.now();

    try {
      await selectOrganization(org.id);
      setOpen(false);
      // Deep routes belong to the previous org; restart at the workspace root
      // before dropping cached data so mounted queries can refetch cleanly.
      router.replace("/");
      queryClient.clear();
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt));
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        setSwitchingOrg(null);
      }, wait);
    } catch {
      setSwitchingOrg(null);
      setErrorOrgId(org.id);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Switch team"
        onPress={() => setOpen(true)}
        disabled={!organizationId}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
      >
        <Text numberOfLines={1} style={styles.triggerLabel}>
          {teamDisplayName ?? "Team"}
        </Text>
        <Text style={styles.triggerChevron}>▾</Text>
      </Pressable>

      <Modal
        transparent
        visible={open}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {
          if (!switchingOrg) setOpen(false);
        }}
      >
        <View style={styles.backdrop}>
          <Pressable
            accessibilityLabel="Close team switcher"
            style={StyleSheet.absoluteFill}
            onPress={() => {
              if (!switchingOrg) setOpen(false);
            }}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Switch team</Text>
              {orgsQuery.isLoading ? <ActivityIndicator color={colors.textMuted} /> : null}
            </View>

            {orgs.map((org) => {
              const active = org.id === organizationId;
              const pending = switchingOrg?.id === org.id;
              return (
                <Pressable
                  key={org.id}
                  accessibilityRole="button"
                  accessibilityLabel={
                    active ? `${org.displayName || org.name}, active` : `Switch to ${org.displayName || org.name}`
                  }
                  disabled={active || !!switchingOrg || orgsQuery.isLoading}
                  onPress={() => void switchTo(org)}
                  style={({ pressed }) => [styles.orgRow, active && styles.orgRowActive, pressed && styles.pressed]}
                >
                  <View style={styles.orgMain}>
                    <Text numberOfLines={1} style={[styles.orgName, active && styles.orgNameActive]}>
                      {org.displayName || org.name}
                    </Text>
                    <Text style={styles.orgRole}>{active ? "Active" : org.role}</Text>
                    {errorOrgId === org.id ? <Text style={styles.orgError}>Switch failed. Try again.</Text> : null}
                  </View>
                  {pending ? <ActivityIndicator color={colors.accent} /> : null}
                </Pressable>
              );
            })}

            {!orgsQuery.isLoading && orgs.length === 0 ? (
              <Text style={styles.empty}>No teams are available.</Text>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Global “Switching to…” veil; mount it once above the router. */
export function TeamSwitchOverlay() {
  const { switchingOrg } = useAuth();
  if (!switchingOrg) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.overlayCard}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.overlayText}>Switching to {switchingOrg.displayName || switchingOrg.name}…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginHorizontal: -4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: "flex-start",
    maxWidth: 280,
  },
  triggerLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  triggerChevron: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.62)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#0B1D28",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 24,
    gap: 2,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  orgRow: {
    minHeight: 58,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  orgRowActive: {
    backgroundColor: "rgba(59,130,246,0.14)",
  },
  orgMain: {
    flex: 1,
  },
  orgName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  orgNameActive: {
    color: colors.accent,
  },
  orgRole: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
    textTransform: "capitalize",
  },
  orgError: {
    color: colors.danger,
    fontSize: 12,
    marginTop: 4,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    padding: 14,
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(4,10,14,0.78)",
  },
  overlayCard: {
    minWidth: 210,
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingVertical: 20,
    paddingHorizontal: 18,
  },
  overlayText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  pressed: {
    opacity: 0.72,
  },
});
