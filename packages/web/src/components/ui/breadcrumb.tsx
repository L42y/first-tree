import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type BreadcrumbProps = HTMLAttributes<HTMLDivElement>;

export function Breadcrumb({ className, style, ...rest }: BreadcrumbProps) {
  return (
    <div
      className={cn("flex items-center text-body", className)}
      style={{
        gap: 6,
        color: "var(--fg-3)",
        ...style,
      }}
      {...rest}
    />
  );
}

type BreadcrumbLinkProps = {
  onClick?: () => void;
  children: ReactNode;
  className?: string;
};

export function BreadcrumbLink({ onClick, children, className }: BreadcrumbLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("bg-transparent border-0 p-0 cursor-pointer", className)}
      style={{ color: "var(--fg-3)", textDecoration: "none", font: "inherit" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--fg-3)";
      }}
    >
      {children}
    </button>
  );
}

export function BreadcrumbSep() {
  return <span style={{ color: "var(--fg-4)" }}>/</span>;
}

export function BreadcrumbCurrent({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={cn("font-medium", mono && "mono")} style={{ color: "var(--fg)" }}>
      {children}
    </span>
  );
}
