import type { AuthProvider, AuthProviderConnection } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Github, Plus, Unlink } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { updateMyProfile } from "../../api/members.js";
import { getAuthProviders, startProviderLink, startProviderUnlink } from "../../api/user-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { Button } from "../../components/ui/button.js";
import { Popover } from "../../components/ui/popover.js";
import { Section } from "../../components/ui/section.js";
import { SettingsField, SettingsSaveButton } from "../../components/ui/settings-field.js";
import { invalidateDisplayNameQueries } from "../../lib/identity-cache.js";

const ERROR_COPY: Record<string, string> = {
  "identity-conflict": "That account is already connected to another First Tree user.",
  "identity-mismatch": "You selected a different account. Sign in with the account currently connected here.",
  "last-provider": "Connect another sign-in method before disconnecting this one.",
  "state-expired": "The authentication request expired. Start again.",
  "provider-not-configured": "This sign-in provider is not configured on this deployment.",
};

type Feedback = {
  kind: "error" | "success";
  message: string;
};

export function SettingsAccountPage() {
  const { user, refreshMe } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [providers, setProviders] = useState<AuthProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setProviderLoadError(null);
    try {
      const result = await getAuthProviders();
      setProviders(result.providers);
    } catch (error) {
      setProviderLoadError(error instanceof Error ? error.message : "Could not load ways to sign in.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const error = params.get("error");
    const connection = params.get("connection");
    if (error) {
      setFeedback({ kind: "error", message: ERROR_COPY[error] ?? "The sign-in method did not update. Try again." });
    } else if (connection) {
      setFeedback({ kind: "success", message: "Sign-in methods updated." });
    }
    if (error || connection) window.history.replaceState(null, "", "/settings/account");
  }, [location.search]);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
  }, [user?.displayName]);

  useEffect(() => {
    if (!profileSaved) return;
    const timeout = window.setTimeout(() => setProfileSaved(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [profileSaved]);

  const normalizedDisplayName = normalizeDisplayName(displayName);
  const currentDisplayName = normalizeDisplayName(user?.displayName ?? "");
  const canSaveProfile =
    normalizedDisplayName.length > 0 && normalizedDisplayName !== currentDisplayName && busy === null;

  const saveProfile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSaveProfile) return;
    setBusy("profile");
    setFeedback(null);
    setProfileSaved(false);
    try {
      await updateMyProfile({ displayName: normalizedDisplayName });
      setDisplayName(normalizedDisplayName);
      await Promise.all([refreshMe(), invalidateDisplayNameQueries(queryClient)]);
      setProfileSaved(true);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Could not update profile." });
    } finally {
      setBusy(null);
    }
  };

  const providerAction = async (provider: AuthProvider, action: "link" | "unlink"): Promise<void> => {
    const providerLabel = provider === "google" ? "Google" : "GitHub";
    if (action === "unlink" && !window.confirm(`Disconnect ${providerLabel}?`)) return;
    setBusy(`${provider}-${action}`);
    setFeedback(null);
    try {
      const result = action === "link" ? await startProviderLink(provider) : await startProviderUnlink(provider);
      window.location.assign(result.redirectUrl);
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : `Could not ${action === "link" ? "connect" : "disconnect"} ${providerLabel}.`,
      });
      setBusy(null);
    }
  };

  const displayNameForIdentity = user?.displayName || user?.username || "User";
  const connectedProviders = providers.filter((provider) => provider.connected);
  const usableConnectedProviders = connectedProviders.filter((provider) => provider.available);
  const availableProviders = providers.filter((provider) => provider.available && !provider.connected);

  return (
    <div
      className="flex w-full max-w-3xl flex-col"
      style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}
    >
      <section
        aria-label="Account identity"
        className="flex items-center"
        style={{ gap: "var(--sp-4)", padding: "var(--sp-2) 0 var(--sp-3)" }}
      >
        <Avatar
          src={user?.avatarUrl ?? null}
          name={displayNameForIdentity}
          seed={user?.id ?? user?.username ?? displayNameForIdentity}
          size={56}
          className="shrink-0"
        />
        <div className="min-w-0">
          <p className="text-title m-0 truncate" style={{ color: "var(--fg)" }}>
            {displayNameForIdentity}
          </p>
          {user?.username ? (
            <p className="text-body m-0 truncate" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              @{user.username}
            </p>
          ) : null}
          <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
            Your avatar comes from the provider you signed up with.
          </p>
        </div>
      </section>

      {feedback ? <FeedbackNotice feedback={feedback} /> : null}

      <Section title="Profile">
        <form onSubmit={(event) => void saveProfile(event)} style={{ paddingTop: "var(--sp-3)" }}>
          <SettingsField
            label="Display name"
            hint="The name teammates and agents see across First Tree."
            value={displayName}
            maxLength={200}
            onChange={(next) => {
              setDisplayName(next);
              setProfileSaved(false);
            }}
            saved={profileSaved}
            rightSlot={<SettingsSaveButton pending={busy === "profile"} disabled={!canSaveProfile} />}
          />
        </form>
      </Section>

      <Section title="Ways to sign in">
        {loading ? (
          <p className="text-body m-0" role="status" style={{ color: "var(--fg-3)", padding: "var(--sp-4) 0" }}>
            Loading ways to sign in…
          </p>
        ) : providerLoadError ? (
          <p className="text-body m-0" role="alert" style={{ color: "var(--color-error)", padding: "var(--sp-4) 0" }}>
            {providerLoadError}
          </p>
        ) : (
          <div style={{ padding: "var(--sp-3) 0 var(--sp-1)" }}>
            <p className="text-body m-0" style={{ color: "var(--fg-3)" }}>
              {connectedProviders.length > 0
                ? usableConnectedProviders.length > 0
                  ? "Use any available connected account to sign in to First Tree."
                  : "Your connected sign-in methods are currently unavailable."
                : availableProviders.length > 0
                  ? "Connect an account to sign in with Google or GitHub."
                  : "No additional sign-in methods are available."}
            </p>
            {connectedProviders.length > 0 ? (
              <div
                style={{
                  marginTop: "var(--sp-3)",
                  borderTop: "var(--hairline) solid var(--border)",
                  borderBottom: "var(--hairline) solid var(--border)",
                }}
              >
                {connectedProviders.map((provider, index) => (
                  <ProviderRow
                    key={provider.provider}
                    provider={provider}
                    busy={busy}
                    onAction={providerAction}
                    separated={index < connectedProviders.length - 1}
                  />
                ))}
              </div>
            ) : null}
            {availableProviders.length > 0 ? (
              <div style={{ marginTop: "var(--sp-3)" }}>
                <ProviderPicker
                  providers={availableProviders}
                  hasConnectedProvider={connectedProviders.length > 0}
                  busy={busy}
                  onAction={providerAction}
                />
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function FeedbackNotice({ feedback }: { feedback: Feedback }) {
  const isError = feedback.kind === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className="text-body m-0"
      style={{
        padding: "var(--sp-2_5) var(--sp-3)",
        borderRadius: "var(--radius-input)",
        color: isError ? "var(--color-error)" : "var(--fg)",
        background: isError ? "var(--color-error-soft)" : "var(--color-success-soft)",
      }}
    >
      {feedback.message}
    </p>
  );
}

function ProviderRow({
  provider,
  busy,
  onAction,
  separated,
}: {
  provider: AuthProviderConnection;
  busy: string | null;
  onAction: (provider: AuthProvider, action: "link" | "unlink") => Promise<void>;
  separated: boolean;
}) {
  const label = provider.provider === "google" ? "Google" : "GitHub";
  return (
    <div
      className="flex items-center justify-between"
      style={{
        gap: "var(--sp-4)",
        padding: "var(--sp-3) var(--sp-2)",
        minWidth: 0,
        borderBottom: separated ? "var(--hairline) solid var(--border-faint)" : undefined,
      }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: "var(--sp-3)" }}>
        <ProviderIcon provider={provider.provider} />
        <div className="min-w-0">
          <p className="text-body font-medium m-0" style={{ color: "var(--fg)" }}>
            {label}
          </p>
          <p className="text-label m-0 truncate" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {provider.accountName || provider.email || "Connected"}
          </p>
        </div>
      </div>
      {provider.available && provider.canUnlink ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={`Disconnect ${label}`}
          disabled={busy !== null}
          onClick={() => void onAction(provider.provider, "unlink")}
        >
          <Unlink className="h-4 w-4" aria-hidden />
          {busy === `${provider.provider}-unlink` ? "Starting…" : "Disconnect"}
        </Button>
      ) : (
        <span
          className="text-label inline-flex shrink-0 items-center"
          style={{ gap: "var(--sp-1)", color: "var(--fg-3)" }}
        >
          {provider.available ? <Check className="h-4 w-4" aria-hidden /> : null}
          {provider.available ? "Connected" : "Unavailable"}
        </span>
      )}
    </div>
  );
}

function ProviderPicker({
  providers,
  hasConnectedProvider,
  busy,
  onAction,
}: {
  providers: AuthProviderConnection[];
  hasConnectedProvider: boolean;
  busy: string | null;
  onAction: (provider: AuthProvider, action: "link" | "unlink") => Promise<void>;
}) {
  const triggerLabel = hasConnectedProvider ? "Add another sign-in method" : "Add a sign-in method";
  return (
    <Popover
      align="start"
      panelStyle={{ minWidth: "var(--sp-60)", padding: "var(--sp-1)" }}
      panelAriaLabel="Available sign-in methods"
      focusOnOpen
      trigger={({ open, toggle }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={busy !== null}
          onClick={toggle}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {busy?.endsWith("-link") ? "Starting…" : triggerLabel}
        </Button>
      )}
    >
      {({ close }) => (
        <div>
          {providers.map((provider) => {
            const label = provider.provider === "google" ? "Google" : "GitHub";
            return (
              <Button
                key={provider.provider}
                type="button"
                variant="ghost"
                disabled={busy !== null}
                className="h-auto w-full justify-start px-2 py-1.5 font-normal"
                onClick={() => {
                  close();
                  void onAction(provider.provider, "link");
                }}
              >
                <ProviderIcon provider={provider.provider} />
                {label}
              </Button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

function ProviderIcon({ provider }: { provider: AuthProvider }) {
  return provider === "github" ? (
    <Github className="h-5 w-5 shrink-0" aria-hidden />
  ) : (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center font-semibold" aria-hidden>
      G
    </span>
  );
}
