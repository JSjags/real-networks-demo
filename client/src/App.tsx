import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ClientId, Order, OutboxEntry } from "../../shared/types";
import { CLIENT_LABELS } from "../../shared/types";
import { ensureSeed, getCursor, getDb, logSync } from "./db";
import { SyncEngine } from "./sync";

const CLIENT_STORAGE_KEY = "order42_client";

function loadClient(): ClientId {
  const saved = localStorage.getItem(CLIENT_STORAGE_KEY);
  if (saved === "ada" || saved === "chidi") return saved;
  // Default: Chidi on desktop-ish widths, Ada on phone
  return window.innerWidth < 700 ? "ada" : "chidi";
}

export function App() {
  const [clientId, setClientId] = useState<ClientId>(() => loadClient());
  const [ready, setReady] = useState(false);
  const [cursor, setCursorState] = useState("c_0");
  const [networkTick, setNetworkTick] = useState(0);
  const [debugOpen, setDebugOpen] = useState(true);
  const [largeDebug, setLargeDebug] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qtyDraft, setQtyDraft] = useState("");
  const [addrDraft, setAddrDraft] = useState("");
  const engineRef = useRef<SyncEngine | null>(null);

  // Bootstrap DB + sync engine whenever client role changes
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    const engine = new SyncEngine(clientId);
    engineRef.current = engine;

    const unsub = engine.subscribe(() => {
      setNetworkTick((n) => n + 1);
      void getCursor(clientId).then(setCursorState);
    });

    (async () => {
      const order = await ensureSeed(clientId);
      if (cancelled) return;
      setQtyDraft(order.quantity);
      setAddrDraft(order.address);
      setCursorState(await getCursor(clientId));
      engine.start();
      setReady(true);
      setNetworkTick((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      unsub();
      engine.stop();
    };
  }, [clientId]);

  const order = useLiveQuery(
    () => (ready ? getDb(clientId).orders.get("42") : undefined),
    [clientId, ready, networkTick]
  );

  const outbox = useLiveQuery(
    () => (ready ? getDb(clientId).outbox.orderBy("seq").toArray() : []),
    [clientId, ready, networkTick]
  ) as OutboxEntry[] | undefined;

  const syncLog = useLiveQuery(
    () =>
      ready
        ? getDb(clientId).syncLog.orderBy("id").reverse().limit(40).toArray()
        : [],
    [clientId, ready, networkTick]
  );

  // Keep drafts in sync when the stored order changes (pull/merge/reset),
  // but not on every live-query rerender — that was wiping in-progress edits.
  const orderStamp = order
    ? `${order.updatedAt}|${order.quantity}|${order.address}`
    : "";
  const outboxBusy = (outbox ?? []).some((e) => e.status !== "synced");
  useEffect(() => {
    if (!order || outboxBusy) return;
    setQtyDraft(order.quantity);
    setAddrDraft(order.address);
  }, [orderStamp, outboxBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;
  const online = engine?.isOnline() ?? true;
  const netMode = engine?.getNetworkMode() ?? "online";
  const wsState = engine?.wsState() ?? "closed";

  const pendingCount = (outbox ?? []).filter((e) => e.status === "pending" || e.status === "sending").length;
  const failedCount = (outbox ?? []).filter((e) => e.status === "failed").length;
  const syncedFlash = (outbox ?? []).some((e) => e.status === "synced");

  async function switchClient(next: ClientId) {
    if (next === clientId) return;
    localStorage.setItem(CLIENT_STORAGE_KEY, next);
    setClientId(next);
  }

  async function saveField(field: "quantity" | "address") {
    if (!engine || !order) return;
    const value = field === "quantity" ? qtyDraft.trim() : addrDraft.trim();
    if (!value) return;
    if (order[field] === value) {
      await logSync(clientId, "info", `No change for ${field}`);
      return;
    }
    setBusy(true);
    try {
      await engine.applyLocalEdit({ [field]: value });
    } finally {
      setBusy(false);
    }
  }

  async function resetDemo() {
    if (!engine) return;
    if (!confirm("Reset order #42 to starting state on server and this device?")) return;
    setBusy(true);
    try {
      await engine.resetDemo();
      setQtyDraft("1 bag");
      setAddrDraft("Ama St.");
    } finally {
      setBusy(false);
    }
  }

  const conflictNotes = collectConflictNotes(order);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">42</div>
          <div>
            <h1>Order #42</h1>
            <p>Offline-first demo · GDG Umuahia · Jesse Abuaja</p>
          </div>
        </div>
        <div className="pill-row">
          <span
            className={`pill ${online ? "green" : "red"}`}
            data-testid="network-pill"
          >
            <span className="dot" />
            {netMode === "online"
              ? "Online"
              : netMode === "offline-simulated"
                ? "Offline (simulated)"
                : "Offline (browser)"}
          </span>
          <span className={`pill ${wsState === "open" ? "blue" : "ghost"}`}>
            WS {wsState}
          </span>
          <span className="pill yellow" data-testid="cursor-pill">
            cursor {cursor}
          </span>
        </div>
      </header>

      <div className="layout">
        <section className="panel" data-testid="order-panel">
          <h2>Shared order</h2>
          <p className="sub">
            Starting state: <strong>1 bag</strong>, delivered to <strong>Ama St.</strong>{" "}
            — Ada edits quantity, Chidi edits address.
          </p>

          <div className="client-switch">
            <button
              type="button"
              className={`client-btn ada ${clientId === "ada" ? "active" : ""}`}
              onClick={() => switchClient("ada")}
              data-testid="pick-ada"
            >
              <strong>Ada</strong>
              <span>Phone · edits quantity</span>
            </button>
            <button
              type="button"
              className={`client-btn chidi ${clientId === "chidi" ? "active" : ""}`}
              onClick={() => switchClient("chidi")}
              data-testid="pick-chidi"
            >
              <strong>Chidi</strong>
              <span>Web · edits address</span>
            </button>
          </div>

          <div className="status-row">
            <span className="pill blue">{CLIENT_LABELS[clientId]}</span>
            {pendingCount > 0 && (
              <span className="badge pending" data-testid="badge-pending">
                pending ×{pendingCount}
              </span>
            )}
            {syncedFlash && (
              <span className="badge synced" data-testid="badge-synced">
                synced
              </span>
            )}
            {failedCount > 0 && (
              <span className="badge failed" data-testid="badge-failed">
                failed ×{failedCount}
              </span>
            )}
            {pendingCount === 0 && failedCount === 0 && !syncedFlash && ready && (
              <span className="badge synced">synced</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="qty">
              Quantity
              <span className="pill ghost" style={{ padding: "4px 10px", fontSize: "0.75rem" }}>
                {order?.fieldMeta.quantity.updatedBy ?? "—"}
              </span>
            </label>
            <input
              id="qty"
              data-testid="input-quantity"
              value={qtyDraft}
              onChange={(e) => setQtyDraft(e.target.value)}
              disabled={!ready || busy}
              placeholder="e.g. 3 bags"
            />
          </div>

          <div className="field">
            <label htmlFor="addr">
              Address
              <span className="pill ghost" style={{ padding: "4px 10px", fontSize: "0.75rem" }}>
                {order?.fieldMeta.address.updatedBy ?? "—"}
              </span>
            </label>
            <input
              id="addr"
              data-testid="input-address"
              value={addrDraft}
              onChange={(e) => setAddrDraft(e.target.value)}
              disabled={!ready || busy}
              placeholder="e.g. Aba Road"
            />
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn primary"
              data-testid="save-quantity"
              disabled={!ready || busy}
              onClick={() => saveField("quantity")}
            >
              Save quantity
            </button>
            <button
              type="button"
              className="btn success"
              data-testid="save-address"
              disabled={!ready || busy}
              onClick={() => saveField("address")}
            >
              Save address
            </button>
            <button
              type="button"
              className="btn subtle"
              data-testid="flush-now"
              disabled={!ready || busy || !online}
              onClick={() => engine?.flush()}
            >
              Flush outbox
            </button>
            <button
              type="button"
              className="btn danger"
              data-testid="reset-demo"
              disabled={!ready || busy}
              onClick={() => resetDemo()}
            >
              Reset #42
            </button>
          </div>

          {conflictNotes.length > 0 && (
            <div className="conflict-box" data-testid="conflict-note">
              <strong>Conflict resolved (last-write-wins per field)</strong>
              {conflictNotes.map((n) => (
                <div key={n}>{n}</div>
              ))}
            </div>
          )}

          <div className="meta-line" data-testid="order-snapshot">
            qty="{order?.quantity ?? "…"}" · addr="{order?.address ?? "…"}" · updated{" "}
            {order?.updatedAt ? new Date(order.updatedAt).toLocaleTimeString() : "—"}
          </div>

          <div className="hint">
            <strong>5-minute live demo (slide 14)</strong>
            <ol>
              <li>Open this tab as Chidi; open the LAN URL on a phone as Ada (or a second tab).</li>
              <li>
                Take both offline: phone airplane mode · Chrome DevTools → Network → Offline
                (or use Simulate offline below).
              </li>
              <li>
                Ada: quantity → <em>3 bags</em>. Chidi: address → <em>Aba Road</em>. Watch pending badges.
              </li>
              <li>Reconnect both — outboxes flush, field-level merge keeps both edits.</li>
              <li>Optional: both edit quantity → conflict note shows last-write-wins.</li>
            </ol>
          </div>
        </section>

        <aside className={`panel debug ${largeDebug ? "large" : ""}`} data-testid="debug-panel">
          <div className="debug-header">
            <h2>Presenter debug</h2>
            <button
              type="button"
              className="btn subtle"
              style={{ padding: "6px 12px" }}
              onClick={() => setDebugOpen((v) => !v)}
            >
              {debugOpen ? "Hide" : "Show"}
            </button>
          </div>

          {debugOpen && (
            <>
              <div className="pill-row" style={{ marginBottom: 12 }}>
                <label className="toggle">
                  <input
                    type="checkbox"
                    data-testid="simulate-offline"
                    checked={engine?.getSimulateOffline() ?? false}
                    onChange={(e) => engine?.setSimulateOffline(e.target.checked)}
                  />
                  Simulate offline
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={largeDebug}
                    onChange={(e) => setLargeDebug(e.target.checked)}
                  />
                  Large text
                </label>
              </div>

              <div className="kv">
                <span>client</span>
                <span data-testid="debug-client">{clientId}</span>
                <span>cursor</span>
                <span data-testid="debug-cursor">{cursor}</span>
                <span>outbox</span>
                <span data-testid="debug-outbox-count">{(outbox ?? []).length} item(s)</span>
                <span>network</span>
                <span>{netMode}</span>
              </div>

              <h2 style={{ fontSize: "0.95rem", margin: "8px 0" }}>Outbox queue</h2>
              {(outbox ?? []).length === 0 ? (
                <div className="empty" data-testid="outbox-empty">
                  (empty — all synced)
                </div>
              ) : (
                <ul className="outbox-list" data-testid="outbox-list">
                  {(outbox ?? []).map((e) => (
                    <li key={e.id}>
                      <strong>[{e.status}]</strong> seq={e.seq} key={e.id.slice(0, 8)}…
                      <br />
                      {JSON.stringify(e.payload.fields)}
                      {e.lastError ? (
                        <>
                          <br />
                          err: {e.lastError}
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <h2 style={{ fontSize: "0.95rem", margin: "14px 0 8px" }}>Sync log</h2>
              <ul className="log-list" data-testid="sync-log">
                {(syncLog ?? []).map((row) => (
                  <li key={row.id} className={row.level}>
                    {new Date(row.at).toLocaleTimeString()} · {row.message}
                  </li>
                ))}
                {(syncLog ?? []).length === 0 && (
                  <li className="info">(waiting for activity)</li>
                )}
              </ul>
            </>
          )}
        </aside>
      </div>

      <p className="footer">
        Building for Real Networks ·{" "}
        <a href="https://github.com/JSjags" target="_blank" rel="noreferrer">
          @JSjags
        </a>{" "}
        · Local DB is source of truth · server is a sync partner
      </p>
    </div>
  );
}

function collectConflictNotes(order: Order | undefined): string[] {
  if (!order) return [];
  const notes: string[] = [];
  if (order.fieldMeta.quantity.conflictNote) notes.push(order.fieldMeta.quantity.conflictNote);
  if (order.fieldMeta.address.conflictNote) notes.push(order.fieldMeta.address.conflictNote);
  return notes;
}
