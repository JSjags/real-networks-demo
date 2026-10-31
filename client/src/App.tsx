import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ClientId, Order, OutboxEntry } from "../../shared/types";
import { ORDER_BASELINE_AT } from "../../shared/types";
import { ensureSeed, getCursor, getDb, logSync } from "./db";
import { SyncEngine } from "./sync";

const CLIENT_STORAGE_KEY = "order42_client";
const HOWTO_STORAGE_KEY = "order42_howto_dismissed";

const NAMES: Record<string, string> = { ada: "Ada", chidi: "Chidi", server: "seed" };

function loadClient(): ClientId {
  const saved = localStorage.getItem(CLIENT_STORAGE_KEY);
  if (saved === "ada" || saved === "chidi") return saved;
  // Default: Chidi on desktop-ish widths, Ada on narrow screens
  return window.innerWidth < 600 ? "ada" : "chidi";
}

function loadHowtoDismissed(): boolean {
  try {
    return localStorage.getItem(HOWTO_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Small (?) explainer: hover or focus shows one plain sentence. */
function Tip({ children, align = "left", label }: { children: ReactNode; align?: "left" | "right" | "center"; label: string }) {
  return (
    <span className={`tip tip-${align}`}>
      <button type="button" className="tip-btn" aria-label={`What is ${label}?`}>
        ?
      </button>
      <span className="tip-card" role="tooltip">
        {children}
      </span>
    </span>
  );
}

type Flash = { n: number; by: string };

export function App() {
  const [clientId, setClientId] = useState<ClientId>(() => loadClient());
  const [ready, setReady] = useState(false);
  const [cursor, setCursorState] = useState("c_0");
  const [networkTick, setNetworkTick] = useState(0);
  const [debugOpen, setDebugOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qtyDraft, setQtyDraft] = useState("");
  const [addrDraft, setAddrDraft] = useState("");
  const [howtoDismissed, setHowtoDismissed] = useState(() => loadHowtoDismissed());
  const [confirmReset, setConfirmReset] = useState(false);
  const [flash, setFlash] = useState<{ quantity: Flash; address: Flash }>({
    quantity: { n: 0, by: "" },
    address: { n: 0, by: "" },
  });
  const [packets, setPackets] = useState<Array<{ id: number; dir: "up" | "down" }>>([]);
  const [burst, setBurst] = useState(0);
  const engineRef = useRef<SyncEngine | null>(null);
  const packetId = useRef(0);

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

  function sendPacket(dir: "up" | "down") {
    const id = ++packetId.current;
    setPackets((p) => [...p.slice(-3), { id, dir }]);
    window.setTimeout(() => setPackets((p) => p.filter((x) => x.id !== id)), 1100);
  }

  // Visual only: flash a field when a value written by the OTHER person lands here.
  const prevMeta = useRef<{ client: ClientId; q?: string; a?: string } | null>(null);
  useEffect(() => {
    if (!order) return;
    const q = order.fieldMeta.quantity;
    const a = order.fieldMeta.address;
    const prev = prevMeta.current;
    prevMeta.current = { client: clientId, q: q.updatedAt, a: a.updatedAt };
    if (!prev || prev.client !== clientId) return;
    let incoming = false;
    const next = { ...flash };
    if (prev.q !== q.updatedAt && q.updatedBy !== clientId && q.updatedBy !== "server") {
      next.quantity = { n: flash.quantity.n + 1, by: q.updatedBy };
      incoming = true;
    }
    if (prev.a !== a.updatedAt && a.updatedBy !== clientId && a.updatedBy !== "server") {
      next.address = { n: flash.address.n + 1, by: a.updatedBy };
      incoming = true;
    }
    if (incoming) {
      setFlash(next);
      sendPacket("down");
    }
  }, [order?.fieldMeta.quantity.updatedAt, order?.fieldMeta.address.updatedAt, clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = engineRef.current;
  const online = engine?.isOnline() ?? true;
  const netMode = engine?.getNetworkMode() ?? "online";
  const wsState = engine?.wsState() ?? "closed";
  const simulating = engine?.getSimulateOffline() ?? false;

  const pendingCount = (outbox ?? []).filter((e) => e.status === "pending" || e.status === "sending").length;
  const failedCount = (outbox ?? []).filter((e) => e.status === "failed").length;
  const syncedFlash = (outbox ?? []).some((e) => e.status === "synced");
  const sending = (outbox ?? []).some((e) => e.status === "sending");

  // Confetti-ish burst + upward packet when this device's outbox lands on the server
  const wasSynced = useRef(false);
  useEffect(() => {
    if (syncedFlash && !wasSynced.current) {
      setBurst((b) => b + 1);
      sendPacket("up");
    }
    wasSynced.current = syncedFlash;
  }, [syncedFlash]);

  async function switchClient(next: ClientId) {
    if (next === clientId) return;
    localStorage.setItem(CLIENT_STORAGE_KEY, next);
    setConfirmReset(false);
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
    setConfirmReset(false);
    setBusy(true);
    try {
      await engine.resetDemo();
      setQtyDraft("1 bag");
      setAddrDraft("Ama St.");
    } finally {
      setBusy(false);
    }
  }

  function dismissHowto() {
    try {
      localStorage.setItem(HOWTO_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setHowtoDismissed(true);
  }

  const conflictNotes = collectConflictNotes(order);
  const qtyBy = order?.fieldMeta.quantity.updatedBy;
  const addrBy = order?.fieldMeta.address.updatedBy;

  const pillText =
    netMode === "online" ? "Online" : netMode === "offline-simulated" ? "Offline (simulated)" : "Offline (browser)";

  return (
    <div className={`app role-${clientId} ${online ? "is-online" : "is-offline"}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            42
          </div>
          <div className="brand-text">
            <h1>Order #42</h1>
            <p>Offline-first demo · GDG Umuahia</p>
          </div>
        </div>
        <div className="top-right">
          <span
            key={netMode}
            className={`pill net ${online ? "green" : "red"}`}
            data-testid="network-pill"
            aria-live="polite"
          >
            <span className="dot" />
            {pillText}
          </span>
          {howtoDismissed && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Show how to try this"
              title="How to try this"
              onClick={() => setHowtoDismissed(false)}
            >
              ?
            </button>
          )}
        </div>
      </header>

      {!howtoDismissed && (
        <section className="howto" data-testid="howto-card" aria-label="How to try this">
          <div className="howto-head">
            <strong>How to try this</strong>
            <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={dismissHowto} data-testid="howto-dismiss">
              ×
            </button>
          </div>
          <ol>
            <li>
              Open this page twice: here as <b>Chidi</b>, and in an <b>Incognito</b> window as <b>Ada</b>.
            </li>
            <li>
              Tick <b>Simulate offline</b> in both, then each saves an edit.
            </li>
            <li>
              Untick it. Both edits merge: no change is lost.
            </li>
          </ol>
        </section>
      )}

      <div className="layout">
        <section className="panel order" data-testid="order-panel">
          <div className="client-switch" role="group" aria-label="Who are you in this window?">
            <button
              type="button"
              className={`client-btn ada ${clientId === "ada" ? "active" : ""}`}
              onClick={() => switchClient("ada")}
              data-testid="pick-ada"
              aria-pressed={clientId === "ada"}
            >
              <span className="avatar">A</span>
              <span className="who">
                <strong>Ada</strong>
                <span>edits quantity</span>
              </span>
            </button>
            <button
              type="button"
              className={`client-btn chidi ${clientId === "chidi" ? "active" : ""}`}
              onClick={() => switchClient("chidi")}
              data-testid="pick-chidi"
              aria-pressed={clientId === "chidi"}
            >
              <span className="avatar">C</span>
              <span className="who">
                <strong>Chidi</strong>
                <span>edits address</span>
              </span>
            </button>
          </div>

          <div className="field-block">
            <div className="field">
              <label htmlFor="qty">
                Quantity
                {qtyBy && (
                  <span key={`q-${order?.fieldMeta.quantity.updatedAt}`} className={`from-chip by-${qtyBy}`}>
                    {qtyBy === "server" ? "seed" : `from ${NAMES[qtyBy]}`}
                  </span>
                )}
              </label>
              <div className="field-row">
                <span className="input-wrap">
                  <input
                    id="qty"
                    data-testid="input-quantity"
                    value={qtyDraft}
                    onChange={(e) => setQtyDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveField("quantity")}
                    disabled={!ready || busy}
                    placeholder="e.g. 3 bags"
                    autoComplete="off"
                  />
                  {flash.quantity.n > 0 && (
                    <span key={flash.quantity.n} className="merge-flash" aria-hidden="true">
                      <span className="merge-tag">merged from {NAMES[flash.quantity.by]}</span>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="save-quantity"
                  disabled={!ready || busy}
                  onClick={() => saveField("quantity")}
                >
                  Save quantity
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="addr">
                Address
                {addrBy && (
                  <span key={`a-${order?.fieldMeta.address.updatedAt}`} className={`from-chip by-${addrBy}`}>
                    {addrBy === "server" ? "seed" : `from ${NAMES[addrBy]}`}
                  </span>
                )}
              </label>
              <div className="field-row">
                <span className="input-wrap">
                  <input
                    id="addr"
                    data-testid="input-address"
                    value={addrDraft}
                    onChange={(e) => setAddrDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveField("address")}
                    disabled={!ready || busy}
                    placeholder="e.g. Aba Road"
                    autoComplete="off"
                  />
                  {flash.address.n > 0 && (
                    <span key={flash.address.n} className="merge-flash" aria-hidden="true">
                      <span className="merge-tag">merged from {NAMES[flash.address.by]}</span>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn success"
                  data-testid="save-address"
                  disabled={!ready || busy}
                  onClick={() => saveField("address")}
                >
                  Save address
                </button>
              </div>
            </div>
          </div>

          <div className="status-row">
            <div className="badges" aria-live="polite">
              {pendingCount > 0 && (
                <span key={`p${pendingCount}`} className="badge pending" data-testid="badge-pending">
                  pending ×{pendingCount}
                </span>
              )}
              {syncedFlash && (
                <span className="badge synced pop" data-testid="badge-synced">
                  synced
                  <span key={burst} className="burst" aria-hidden="true">
                    {Array.from({ length: 12 }, (_, i) => (
                      <i key={i} style={{ ["--i" as string]: i }} />
                    ))}
                  </span>
                </span>
              )}
              {failedCount > 0 && (
                <span key={`f${failedCount}`} className="badge failed" data-testid="badge-failed">
                  failed ×{failedCount}
                </span>
              )}
              {pendingCount === 0 && failedCount === 0 && !syncedFlash && ready && (
                <span className="badge synced">synced</span>
              )}
              <Tip label="the badges">
                <b>pending</b> = saved on this device, waiting to send. <b>synced</b> = the server has it.{" "}
                <b>failed</b> = send failed, it will retry with backoff.
              </Tip>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn subtle"
                data-testid="flush-now"
                disabled={!ready || busy || !online}
                onClick={() => engine?.flush()}
              >
                Flush outbox
              </button>
              <span className="reset-wrap">
                <button
                  type="button"
                  className="btn danger"
                  data-testid="reset-demo"
                  disabled={!ready || busy}
                  onClick={() => setConfirmReset((v) => !v)}
                  aria-expanded={confirmReset}
                >
                  Reset #42
                </button>
                {confirmReset && (
                  <span className="confirm-pop" role="alertdialog" aria-label="Confirm reset" data-testid="reset-confirm-box">
                    <span className="confirm-text">
                      Reset order #42 to <b>1 bag, Ama St.</b> on the server and this window?
                    </span>
                    <span className="confirm-actions">
                      <button type="button" className="btn tiny ghost" onClick={() => setConfirmReset(false)} data-testid="reset-cancel">
                        Cancel
                      </button>
                      <button type="button" className="btn tiny danger" onClick={() => resetDemo()} data-testid="reset-confirm" autoFocus>
                        Yes, reset
                      </button>
                    </span>
                  </span>
                )}
              </span>
              <Tip label="Flush and Reset" align="right">
                <b>Flush outbox</b> sends queued changes now instead of waiting. <b>Reset #42</b> puts the shared order
                back to 1 bag, Ama St. for everyone.
              </Tip>
            </div>
          </div>

          {conflictNotes.length > 0 && (
            <div className="conflict-box" data-testid="conflict-note">
              <div className="conflict-head">
                <strong>Conflict resolved (last-write-wins per field)</strong>
                <Tip label="the conflict note" align="right">
                  Both people changed the same field, so the newest edit won. Different fields never conflict.
                </Tip>
              </div>
              {conflictNotes.map((n) => (
                <div key={n} className="conflict-line">
                  {n}
                </div>
              ))}
            </div>
          )}

          <div className="meta-line" data-testid="order-snapshot">
            <span className="meta-tag">local DB</span>
            qty="{order?.quantity ?? "…"}" · addr="{order?.address ?? "…"}" · updated{" "}
            {!order?.updatedAt ? "—" : order.updatedAt === ORDER_BASELINE_AT ? "seed" : new Date(order.updatedAt).toLocaleTimeString()}
          </div>
        </section>

        <aside className="panel debug" data-testid="debug-panel">
          <div className="debug-header">
            <h2>Presenter debug</h2>
            <button
              type="button"
              className="btn tiny ghost"
              onClick={() => setDebugOpen((v) => !v)}
              aria-expanded={debugOpen}
            >
              {debugOpen ? "Hide" : "Show"}
            </button>
          </div>

          <div className="offline-row">
            <label className={`switch ${simulating ? "on" : ""}`}>
              <input
                type="checkbox"
                data-testid="simulate-offline"
                checked={simulating}
                onChange={(e) => engine?.setSimulateOffline(e.target.checked)}
              />
              <span className="track" aria-hidden="true">
                <span className="knob" />
              </span>
              Simulate offline
            </label>
            <Tip label="Simulate offline" align="right">
              Cuts this window off from the server: no requests, no WebSocket. Your real internet stays on.
            </Tip>
          </div>

          <div className={`lane ${online ? "" : "cut"} ${sending ? "busy" : ""}`} aria-hidden="true">
            <span className="node">{NAMES[clientId]}'s DB</span>
            <span className="wire">
              {packets.map((p) => (
                <span key={p.id} className={`packet ${p.dir}`} />
              ))}
              {!online && <span className="cut-mark">✕</span>}
            </span>
            <span className="node server">server</span>
          </div>

          {debugOpen && (
            <>
              <div className="kv">
                <span className="kv-item">
                  <span>client</span>
                  <b data-testid="debug-client">{clientId}</b>
                </span>
                <span className="kv-item" data-testid="cursor-pill">
                  <span>cursor</span>
                  <b data-testid="debug-cursor" key={cursor} className="tick">
                    {cursor}
                  </b>
                  <Tip label="the cursor">
                    The last server change this window has seen. On reconnect it asks for “everything since {cursor}”.
                  </Tip>
                </span>
                <span className="kv-item">
                  <span>WS</span>
                  <b className={`ws ws-${wsState}`}>
                    {wsState}
                  </b>
                </span>
                <span className="kv-item">
                  <span>outbox</span>
                  <b data-testid="debug-outbox-count">{(outbox ?? []).length} item(s)</b>
                </span>
              </div>

              <div className="debug-cols">
                <div>
                  <h3>
                    Outbox queue
                    <Tip label="the outbox">
                      Changes saved on this device but not yet confirmed by the server. Each has a unique key so a retry is
                      never applied twice.
                    </Tip>
                  </h3>
                  {(outbox ?? []).length === 0 ? (
                    <div className="empty" data-testid="outbox-empty">
                      empty · all synced
                    </div>
                  ) : (
                    <ul className="outbox-list" data-testid="outbox-list">
                      {(outbox ?? []).map((e) => (
                        <li key={e.id} className={`ob ob-${e.status}`}>
                          <span className="ob-top">
                            <span className={`ob-status s-${e.status}`}>{e.status}</span>
                            <span className="ob-key">#{e.seq} · key {e.id.slice(0, 8)}</span>
                          </span>
                          <code>{JSON.stringify(e.payload.fields)}</code>
                          {e.lastError ? <span className="ob-err">err: {e.lastError}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3>Sync log</h3>
                  <ul className="log-list" data-testid="sync-log">
                    {(syncLog ?? []).map((row) => (
                      <li key={row.id} className={row.level}>
                        <span className="t">{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                        {row.message}
                      </li>
                    ))}
                    {(syncLog ?? []).length === 0 && <li className="info">(waiting for activity)</li>}
                  </ul>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      <p className="footer">
        Building for Real Networks ·{" "}
        <a href="https://github.com/JSjags/real-networks-demo" target="_blank" rel="noreferrer">
          source on GitHub
        </a>{" "}
        · the local DB is the source of truth; the server is a sync partner
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
