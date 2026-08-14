import type { ReactElement, ReactNode } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { OpenTagLogo } from "./opentag-logo.js";

export function OpenTagShell({
  displayName,
  identityState,
  editingName,
  onEditName,
  onCancelEditName,
  onNameChange,
  children,
}: {
  displayName: string;
  identityState: "editable" | "created" | "ready";
  editingName: boolean;
  onEditName: () => void;
  onCancelEditName: () => void;
  onNameChange: (name: string) => void;
  children: ReactNode;
}): ReactElement {
  const { logout } = useAuth();

  return (
    <div
      data-opentag-theme="light"
      className="min-h-screen"
      style={{ background: "var(--opentag-bg)", color: "var(--fg)" }}
    >
      <header
        className="flex items-center justify-between border-b border-border-faint"
        style={{ padding: "var(--sp-8) var(--sp-12)" }}
      >
        <OpenTagLogo />
        <Button type="button" variant="link" className="h-auto p-0 text-lead font-normal" onClick={logout}>
          Sign out
        </Button>
      </header>

      <main
        className="mx-auto grid items-start"
        style={{
          width: "min(calc(100% - (var(--opentag-page-gutter) * 2)), var(--opentag-page-max))",
          gridTemplateColumns: "var(--opentag-grid-columns)",
          columnGap: "var(--opentag-column-gap)",
          paddingTop: "var(--opentag-content-top)",
          paddingBottom: "var(--sp-20)",
        }}
      >
        <section>
          <h1 className="text-opentag-display font-bold" style={{ margin: 0, maxWidth: "var(--opentag-story-width)" }}>
            Bring your agent
            <br /> to Feishu
          </h1>
          <p
            className="text-lead"
            style={{ margin: "var(--sp-7) 0 0", color: "var(--fg-2)", maxWidth: "var(--sp-95)" }}
          >
            Your agent runs on your computer. Work with it from Feishu.
          </p>

          <div className="flex items-center" style={{ gap: "var(--sp-6)", marginTop: "var(--opentag-identity-top)" }}>
            <span className="text-lead" style={{ color: "var(--fg-2)" }}>
              Your agent
            </span>
            {editingName ? (
              <label className="flex items-center" style={{ gap: "var(--sp-2)" }}>
                <span className="sr-only">Agent name</span>
                <input
                  id="opentag-agent-name"
                  className="h-10 rounded-[var(--radius-input)] border border-input bg-background px-3 text-lead font-semibold outline-none focus:border-ring"
                  value={displayName}
                  maxLength={200}
                  onChange={(event) => onNameChange(event.target.value)}
                />
                <Button type="button" variant="link" className="h-auto p-0 text-body" onClick={onCancelEditName}>
                  Done
                </Button>
              </label>
            ) : (
              <>
                <span className="text-lead font-semibold">{displayName}</span>
                {identityState === "editable" ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-body font-normal"
                    onClick={onEditName}
                  >
                    Change name
                  </Button>
                ) : (
                  <span className="text-lead" style={{ color: "var(--fg-3)" }}>
                    {identityState === "ready" ? "Ready in Feishu" : "Created"}
                  </span>
                )}
              </>
            )}
          </div>
        </section>

        <section className="min-w-0">{children}</section>
      </main>
    </div>
  );
}
