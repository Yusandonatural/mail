"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { markReadAction } from "@/app/actions/mail";

/** メールを開いたら既読にし、一覧と左の件数を新しくする */
export function MarkRead({ rowId }: { rowId: number }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    markReadAction(rowId)
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [rowId, router]);
  return null;
}
