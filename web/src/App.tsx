import { useEffect, useState } from "react";

type BackendStatus = "loading" | "ok" | "unreachable";

export function App() {
  const [status, setStatus] = useState<BackendStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    fetch("/healthz")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body: unknown = await res.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("ok" in body) ||
          (body as { ok: unknown }).ok !== true
        ) {
          throw new Error("unexpected health response");
        }
        if (!cancelled) {
          setStatus("ok");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("unreachable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const label =
    status === "loading"
      ? "backend: …"
      : status === "ok"
        ? "backend: ok"
        : "backend: unreachable";

  return (
    <main>
      <h1>Tyflix</h1>
      <p>{label}</p>
    </main>
  );
}
