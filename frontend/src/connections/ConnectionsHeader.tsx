import { type ReactNode, useEffect, useState } from "react";
import mindroomLogo from "../../../assets/logo/logo-mark-animated.svgz?url";
import { requestConnection } from "./request";
import type { ConnectionsIdentity } from "./types";

type Page = "agents" | "keys";

const LINKS: readonly { page: Page; href: string; label: string }[] = [
  { page: "agents", href: "/connections", label: "Agents" },
  { page: "keys", href: "/connections/egress", label: "API keys and accounts" },
];

/**
 * Title, intro, who is signed in, and links between the Connections pages.
 *
 * The identity is a courtesy: when it cannot be loaded the header shows the
 * links without it, and the page's own requests report any real failure.
 */
export function ConnectionsHeader({
  current,
  title,
  children,
}: {
  current: Page;
  title: string;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<ConnectionsIdentity | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestConnection<ConnectionsIdentity>(
      "/api/connections/me",
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setIdentity(data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const linkClass = (active: boolean) =>
    `rounded-md px-2.5 py-1.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;
  return (
    <header className="space-y-4">
      <div className="flex items-start gap-4">
        <img src={mindroomLogo} alt="" className="h-12 w-12 shrink-0" />
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <nav
          aria-label="Connections pages"
          className="-ml-2.5 flex flex-wrap items-center gap-1"
        >
          {LINKS.map(({ page, href, label }) => (
            <a
              key={page}
              href={href}
              aria-current={page === current ? "page" : undefined}
              className={linkClass(page === current)}
            >
              {label}
            </a>
          ))}
          {identity?.is_administrator && (
            <a href="/" className={linkClass(false)}>
              Dashboard
            </a>
          )}
        </nav>
        {identity && (
          <span className="break-all text-muted-foreground">
            {`Signed in as ${identity.matrix_user_id}`}
          </span>
        )}
      </div>
    </header>
  );
}
