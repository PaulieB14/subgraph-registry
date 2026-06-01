"use client";
import { useEffect, useState } from "react";

/**
 * Renders children only after the component has mounted on the client.
 * Used to wrap Recharts' ResponsiveContainer, which relies on
 * ResizeObserver and measures 0px during SSR.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <>{mounted ? children : fallback}</>;
}
