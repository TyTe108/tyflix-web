import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchAdminSystem,
  formatPct,
  formatTempC,
  formatUptime,
  type AdminSystem,
  type AdminSystemGpu,
  type AdminSystemStorage,
} from "../api/admin";

type LoadStatus = "loading" | "ready" | "error";

export function AdminPage() {
  const [system, setSystem] = useState<AdminSystem | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAdminSystem()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setSystem(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setSystem(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load system status",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">
        <h1>Admin</h1>
        <Link to="/">Back to Home</Link>
      </header>

      <section className="admin-section" aria-labelledby="system-heading">
        <h2 id="system-heading">System / Storage</h2>

        {status === "loading" ? (
          <p className="muted">Loading system status…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load system status"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && system !== null ? (
          <SystemPanel system={system} />
        ) : null}
      </section>

      <ComingNextSection title="Users" />
      <ComingNextSection title="Jobs" />
      <ComingNextSection title="Containers" />
    </main>
  );
}

function ComingNextSection({ title }: { title: string }) {
  const id = `coming-${title.toLowerCase()}`;
  return (
    <section className="admin-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="muted">Coming next.</p>
    </section>
  );
}

function SystemPanel({ system }: { system: AdminSystem }) {
  const { cpu, mem, load, temps, gpu, storage, services } = system;

  return (
    <div className="admin-system">
      <p className="admin-host">
        <strong>{system.host}</strong>
        <span className="muted"> · up {formatUptime(system.uptime_s)}</span>
      </p>

      <dl className="admin-metrics">
        <div>
          <dt>CPU</dt>
          <dd>
            {formatPct(cpu.pct)}
            <span className="muted admin-metric-sub">
              {cpu.cores} cores · {cpu.model}
            </span>
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {formatPct(mem.pct)}
            <span className="muted admin-metric-sub">
              {mem.used_h} / {mem.total_h}
            </span>
          </dd>
        </div>
        <div>
          <dt>Load</dt>
          <dd>
            {load["1"]} / {load["5"]} / {load["15"]}
            <span className="muted admin-metric-sub">
              1m {formatPct(load.pct_1)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Temps</dt>
          <dd>
            CPU {formatTempC(temps.cpu_c)}
            <span className="muted admin-metric-sub">
              GPU {formatTempC(temps.gpu_c)}
            </span>
          </dd>
        </div>
      </dl>

      <GpuBlock gpu={gpu} />

      <h3 className="admin-subheading">Storage</h3>
      <ul className="admin-storage-list">
        {storage.map((drive) => (
          <StorageRow key={drive.label} drive={drive} />
        ))}
      </ul>

      <h3 className="admin-subheading">Services</h3>
      <ul className="admin-services-list">
        {services.map((svc) => (
          <li key={svc.name}>
            <span
              className={
                svc.up ? "admin-service-dot up" : "admin-service-dot down"
              }
              aria-hidden="true"
            />
            <span className="admin-service-name">{svc.name}</span>
            <span className="muted admin-service-detail">
              {svc.up ? "up" : "down"}
              {svc.detail ? ` · ${svc.detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GpuBlock({ gpu }: { gpu: AdminSystemGpu }) {
  if (gpu === null) {
    return (
      <div className="admin-gpu">
        <h3 className="admin-subheading">GPU</h3>
        <p className="muted">No GPU data.</p>
      </div>
    );
  }

  const usage = gpu.usage;
  const engines = usage?.engines;

  return (
    <div className="admin-gpu">
      <h3 className="admin-subheading">GPU</h3>
      <p className="admin-gpu-name">{gpu.name}</p>
      <p className="muted admin-gpu-meta">
        {gpu.transcodes} transcoder{gpu.transcodes === 1 ? "" : "s"} ·{" "}
        {gpu.streams} stream{gpu.streams === 1 ? "" : "s"}
        {gpu.hw ? " · HW" : ""}
        {usage != null ? ` · busy ${formatPct(usage.busy)}` : null}
      </p>
      {engines != null ? (
        <dl className="admin-engines">
          <div>
            <dt>Video</dt>
            <dd>{formatPct(engines.video)}</dd>
          </div>
          <div>
            <dt>Enhance</dt>
            <dd>{formatPct(engines.video_enhance)}</dd>
          </div>
          <div>
            <dt>Render</dt>
            <dd>{formatPct(engines.render)}</dd>
          </div>
          <div>
            <dt>Blitter</dt>
            <dd>{formatPct(engines.blitter)}</dd>
          </div>
          <div>
            <dt>Compute</dt>
            <dd>{formatPct(engines.compute)}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function StorageRow({ drive }: { drive: AdminSystemStorage }) {
  if (!drive.online) {
    return (
      <li className="admin-storage-row offline">
        <div className="admin-storage-head">
          <span className="admin-storage-label">{drive.label}</span>
          <span className="admin-tag">Offline</span>
        </div>
        <p className="muted admin-storage-meta">{drive.role}</p>
      </li>
    );
  }

  const pct = Math.min(100, Math.max(0, drive.pct));

  return (
    <li className="admin-storage-row">
      <div className="admin-storage-head">
        <span className="admin-storage-label">{drive.label}</span>
        <span className="muted">
          {drive.used_h} / {drive.total_h} · {formatPct(drive.pct)}
        </span>
      </div>
      <p className="muted admin-storage-meta">
        {drive.role} · {drive.fstype} · {drive.avail_h} free
      </p>
      <div
        className="stats-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${drive.label} usage`}
      >
        <div className="stats-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}
