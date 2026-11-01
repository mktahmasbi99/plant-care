import type { ReactNode, SyntheticEvent } from "react";

export function SettingsDisclosure({
  title,
  children,
  initiallyOpen = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  initiallyOpen?: boolean;
  className?: string;
}) {
  const updateExpanded = (event: SyntheticEvent<HTMLDetailsElement>) => {
    event.currentTarget.querySelector("summary")?.setAttribute("aria-expanded", String(event.currentTarget.open));
  };

  return (
    <details className={`panel settings settings-disclosure ${className}`} open={initiallyOpen} onToggle={updateExpanded}>
      <summary role="button" aria-expanded={initiallyOpen}><h2>{title}</h2></summary>
      {children}
    </details>
  );
}
