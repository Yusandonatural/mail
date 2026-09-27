"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function NavLink({
  href,
  children,
  count,
  hot,
}: {
  href: string;
  children: React.ReactNode;
  count?: number;
  hot?: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const url = new URL(href, "http://x");
  const active =
    pathname === url.pathname && (url.searchParams.get("folder") ?? "") === (params.get("folder") ?? "");
  return (
    <Link href={href} className={active ? "active" : undefined}>
      <span>{children}</span>
      {count ? <span className={hot ? "count hot" : "count"}>{count}</span> : null}
    </Link>
  );
}
