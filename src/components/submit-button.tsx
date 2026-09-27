"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  className,
  ...rest
}: { children: React.ReactNode; className?: string } & Record<`data-${string}`, boolean | string | undefined>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} {...rest}>
      {pending ? "処理中…" : children}
    </button>
  );
}
