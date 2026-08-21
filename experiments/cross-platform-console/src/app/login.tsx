import type { AuthProviderAvailability } from "~/lib/auth-api";
import { DEFAULT_PROVIDER_AVAILABILITY, fetchBootstrapConfig } from "~/lib/auth-api";
import type { OAuthCompletion, SignInProvider } from "~/lib/oauth";
import { CALLBACK_ERROR_COPY } from "~/lib/oauth";
import { OAuthSheet } from "~/components/oauth-sheet";
import { useAuth } from "~/lib/auth-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

/**
 * Sign-in entry. First Tree deployments authenticate exclusively through
 * OAuth (Google / GitHub / SSO) — the same surfaces as the web console's
 * login page (packages/web/src/pages/login.tsx). There is no password
 * form: the legacy username/password endpoint was retired on the server.
 *
 * Provider availability comes from the public bootstrap endpoint
 * (`GET /api/v1/bootstrap/config`), exactly like the web login page, so a
 * self-hosted deployment never renders a broken OAuth choice.
 */
export default function LoginScreen() {
  const { adoptTokens } = useAuth();
  const [providers, setProviders] = useState<AuthProviderAvailability>(DEFAULT_PROVIDER_AVAILABILITY);
  const [providersSettled, setProvidersSettled] = useState(false);
  const [activeProvider, setActiveProvider] = useState<SignInProvider | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchBootstrapConfig(controller.signal)
      .then((config) => {
        setProviders(config.authProviders ?? DEFAULT_PROVIDER_AVAILABILITY);
        setProvidersSettled(true);
      })
      .catch(() => {
        // Fail closed like the web console: unknown availability renders no
        // buttons rather than a broken OAuth choice.
        setProviders(DEFAULT_PROVIDER_AVAILABILITY);
        setProvidersSettled(true);
      });
    return () => controller.abort();
  }, []);

  const availableProviders = useMemo(
    () =>
      (["google", "github", "oidc"] as SignInProvider[]).filter((p) => providers[p]),
    [providers],
  );

  const closeSheet = () => {
    setActiveProvider(null);
    setSheetError(null);
    handledRef.current = false;
  };

  const handleCompletion = async (completion: OAuthCompletion) => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (completion.kind === "error") {
      setSheetError(CALLBACK_ERROR_COPY[completion.code] ?? "Sign-in did not complete. Please try again.");
      return;
    }
    setAdopting(true);
    try {
      await adoptTokens({ accessToken: completion.accessToken, refreshToken: completion.refreshToken });
      closeSheet();
    } catch {
      handledRef.current = false;
      setSheetError("Sign-in completed, but First Tree couldn't open your workspace. Please try again.");
    } finally {
      setAdopting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>First Tree</Text>
        <Text style={styles.subtitle}>Sign in to your workspace</Text>

        {!providersSettled ? (
          <ActivityIndicator style={styles.loading} />
        ) : availableProviders.length === 0 ? (
          <Text style={styles.hint}>No sign-in providers are configured. Contact your administrator.</Text>
        ) : (
          availableProviders.map((provider) => (
            <Pressable
              key={provider}
              onPress={() => {
                setSheetError(null);
                handledRef.current = false;
                setActiveProvider(provider);
              }}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            >
              <Text style={styles.buttonText}>{PROVIDER_LABELS[provider]}</Text>
            </Pressable>
          ))
        )}

        <Text style={styles.hint}>
          Sign-in uses your Google or GitHub identity. You authorize a repo later, only when an agent needs to work in
          it.
        </Text>
      </View>

      {sheetError ? (
        <View style={styles.errorWrap}>
          <Text style={styles.sheetError}>{sheetError}</Text>
          <Pressable
            style={[styles.button, styles.retryButton]}
            onPress={() => {
              setSheetError(null);
              handledRef.current = false;
              setActiveProvider(activeProvider);
            }}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : adopting ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        <OAuthSheet provider={activeProvider} onClose={closeSheet} onComplete={handleCompletion} />
      )}
    </View>
  );
}

const PROVIDER_LABELS: Record<SignInProvider, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
  oidc: "Continue with SSO",
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    textAlign: "center",
  },
  subtitle: {
    textAlign: "center",
    opacity: 0.7,
    marginBottom: 8,
  },
  hint: {
    textAlign: "center",
    opacity: 0.6,
    fontSize: 13,
    marginTop: 8,
  },
  loading: {
    marginTop: 16,
  },
  button: {
    height: 48,
    borderRadius: 8,
    backgroundColor: "#3B82F6",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  errorWrap: {
    position: "absolute",
    bottom: 48,
    left: 24,
    right: 24,
    gap: 16,
  },
  sheetError: {
    textAlign: "center",
    fontSize: 15,
    color: "#374151",
  },
  retryButton: {
    marginTop: 8,
  },
});
