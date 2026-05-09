import { useCallback, useEffect, useState } from "react";

/**
 * Two-way bind a URL search-param to React state. Updates the URL via
 * pushState (back-button works, the value is shareable) and listens for
 * popstate so navigation propagates back into state.
 */
export function useUrlParam(key: string): [string | null, (next: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get(key);
  });

  useEffect(() => {
    const onPop = () => {
      setValue(new URLSearchParams(window.location.search).get(key));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [key]);

  const update = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next === null) params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      const url = `${window.location.pathname}${qs ? "?" + qs : ""}`;
      window.history.pushState({}, "", url);
      setValue(next);
    },
    [key]
  );

  return [value, update];
}
