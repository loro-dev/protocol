import {
  CrdtType,
  ProtocolMessage,
  tryDecode,
  MessageType,
  JoinResponseOk,
  encode,
  JoinRequest,
  DocUpdate,
  JoinError,
  DocUpdateFragmentHeader,
  DocUpdateFragment,
  UpdateError,
  UpdateErrorCode,
  Leave,
  JoinErrorCode,
  MAX_MESSAGE_SIZE,
  bytesToHex,
} from "loro-protocol";
import type { CrdtDocAdaptor } from "loro-adaptors";

export * from "loro-adaptors";

interface FragmentBatch {
  header: DocUpdateFragmentHeader;
  fragments: Map<number, Uint8Array>;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingRoom {
  room: Promise<LoroWebsocketClientRoom>;
  resolve: (res: JoinResponseOk) => void;
  reject: (error: Error) => void;
  adaptor: CrdtDocAdaptor;
  roomId: string;
  auth?: Uint8Array;
  isRejoin?: boolean;
}

interface InternalRoomHandler {
  handleDocUpdate(updates: Uint8Array[]): void;
  handleUpdateError(error: UpdateError): void;
}

interface ActiveRoom {
  room: LoroWebsocketClientRoom;
  handler: InternalRoomHandler;
}

interface SocketListeners {
  open: () => void;
  error: (event: Event) => void;
  close: (event: CloseEvent) => void;
  message: (event: MessageEvent<string | ArrayBuffer>) => void;
}

type NodeProcessLike = {
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

/**
 * The websocket client's high-level connection status.
 * - `Connecting`: initial connect or a manual `connect()` in progress.
 * - `Connected`: the websocket is open and usable.
 * - `Disconnected`: the client is not connected. Call `connect()` to retry.
 */
export const ClientStatus = {
  Connecting: "connecting",
  Connected: "connected",
  Disconnected: "disconnected",
} as const;
export type ClientStatusValue =
  (typeof ClientStatus)[keyof typeof ClientStatus];

/**
 * Options for `LoroWebsocketClient`.
 *
 * Behavior summary:
 * - The client auto-connects on construction and retries on unexpected closures with an exponential backoff.
 * - Call `close()` to stop auto-reconnect and move to `Disconnected`. Call `connect()` to resume.
 * - Pings are sent periodically to keep the connection alive; `latency` estimates are updated on pong.
 */
export interface LoroWebsocketClientOptions {
  /** WebSocket URL (ws:// or wss://). */
  url: string;
  /** Optional custom ping interval. Defaults to 30s. Set with `disablePing` to stop timers. */
  pingIntervalMs?: number;
  /** Ping timeout; after two consecutive misses the client will force-close and reconnect. Defaults to 10s. */
  pingTimeoutMs?: number;
  /** Disable periodic ping/pong entirely. */
  disablePing?: boolean;
  /** Optional callback for low-level ws close (before status transitions). */
  onWsClose?: () => void;
  /**
   * Reconnect policy (kept minimal).
   * - enabled: toggle auto-retry (default true)
   * - initialDelayMs: starting backoff delay (default 500)
   * - maxDelayMs: max backoff delay (default 15000)
   * - jitter: 0-1 multiplier applied randomly around the delay (default 0.25)
   * - maxAttempts: number | "infinite" (default "infinite")
   * - fatalCloseCodes: close codes that should not retry (default 4400-4499, 1008, 1011)
   * - fatalCloseReasons: close reasons that should not retry (default permission_changed, room_closed, auth_failed)
   */
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    maxAttempts?: number | "infinite";
    fatalCloseCodes?: number[];
    fatalCloseReasons?: string[];
  };
}

export const RoomJoinStatus = {
  Connecting: "connecting",
  Joined: "joined",
  Reconnecting: "reconnecting",
  Disconnected: "disconnected",
  Error: "error",
} as const;
export type RoomJoinStatusValue =
  (typeof RoomJoinStatus)[keyof typeof RoomJoinStatus];

/**
 * Loro websocket client with auto-reconnect, connection status events, and latency tracking.
 *
 * Status model:
 * - `Connected`: ws open.
 * - `Disconnected`: socket closed. Auto-reconnect retries run unless `close()`/`destroy()` stop them.
 * - `Connecting`: initial or manual connect in progress.
 *
 * Events:
 * - `onStatusChange(cb)`: called whenever status changes.
 * - `onLatency(cb)`: called when a new RTT estimate is measured from ping/pong.
 */
export class LoroWebsocketClient {
  private ws!: WebSocket;
  private connectedPromise!: Promise<void>;
  private resolveConnected?: () => void;
  private rejectConnected?: (e: Error) => void;
  private status: ClientStatusValue = ClientStatus.Connecting;
  private statusListeners = new Set<(s: ClientStatusValue) => void>();
  private latencyListeners = new Set<(ms: number) => void>();
  private lastLatencyMs?: number;
  private awaitingPongSince?: number;

  private pendingRooms: Map<string, PendingRoom> = new Map();
  private activeRooms: Map<string, ActiveRoom> = new Map();
  // Buffer for %ELO only: backfills can arrive immediately after JoinResponseOk
  private preJoinUpdates: Map<string, Uint8Array[]> = new Map();
  private fragmentBatches: Map<string, FragmentBatch> = new Map();
  private roomAdaptors: Map<string, CrdtDocAdaptor> = new Map();
  // Track roomId for each active id so we can rejoin on reconnect
  private roomIds: Map<string, string> = new Map();
  private roomAuth: Map<string, Uint8Array | undefined> = new Map();
  private roomStatusListeners: Map<
    string,
    Set<(s: RoomJoinStatusValue) => void>
  > = new Map();
  private socketListeners = new WeakMap<WebSocket, SocketListeners>();

  private pingTimer?: ReturnType<typeof setInterval>;
  private pingWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];
  private missedPongs = 0;

  // Reconnect controls
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private removeNetworkListeners?: () => void;
  private offline = false;

  // Join requests issued while socket is still connecting
  private queuedJoins: Uint8Array[] = [];

  constructor(private ops: LoroWebsocketClientOptions) {
    this.attachNetworkListeners();

    // Start initial connection
    this.ensureConnectedPromise();
    void this.connect();
  }

  get socket(): WebSocket {
    return this.ws;
  }

  private ensureConnectedPromise(): void {
    if (this.resolveConnected) return;
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnected = () => {
        this.resolveConnected = undefined;
        this.rejectConnected = undefined;
        resolve();
      };
      this.rejectConnected = (err: Error) => {
        this.resolveConnected = undefined;
        this.rejectConnected = undefined;
        reject(err);
      };
    });
  }

  private attachNetworkListeners(): void {
    this.removeNetworkListeners?.();
    this.removeNetworkListeners = undefined;

    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
      this.removeNetworkListeners = () => {
        window.removeEventListener("online", this.handleOnline);
        window.removeEventListener("offline", this.handleOffline);
      };
      return;
    }

    const globalScope = globalThis as typeof globalThis & {
      addEventListener?: (
        type: string,
        listener: EventListenerOrEventListenerObject
      ) => void;
      removeEventListener?: (
        type: string,
        listener: EventListenerOrEventListenerObject
      ) => void;
      process?: NodeProcessLike;
    };

    if (typeof globalScope.addEventListener === "function") {
      const online = this.handleOnline as EventListener;
      const offline = this.handleOffline as EventListener;
      globalScope.addEventListener("online", online);
      globalScope.addEventListener("offline", offline);
      this.removeNetworkListeners = () => {
        globalScope.removeEventListener?.("online", online);
        globalScope.removeEventListener?.("offline", offline);
      };
      return;
    }

    const maybeProcess = globalScope.process;
    if (maybeProcess && typeof maybeProcess.on === "function") {
      // Node environments may surface online/offline via the global process emitter.
      const online = () => {
        this.handleOnline();
      };
      const offline = () => {
        this.handleOffline();
      };
      maybeProcess.on("online", online);
      maybeProcess.on("offline", offline);
      this.removeNetworkListeners = () => {
        if (typeof maybeProcess.off === "function") {
          maybeProcess.off("online", online);
          maybeProcess.off("offline", offline);
        } else if (typeof maybeProcess.removeListener === "function") {
          maybeProcess.removeListener("online", online);
          maybeProcess.removeListener("offline", offline);
        }
      };
    }
  }

  /** Current client status. */
  getStatus(): ClientStatusValue {
    return this.status;
  }

  /** Latest measured RTT in ms (if any). */
  getLatency(): number | undefined {
    return this.lastLatencyMs;
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(cb: (s: ClientStatusValue) => void): () => void {
    this.statusListeners.add(cb);
    // Emit current immediately to inform subscribers
    try {
      cb(this.status);
    } catch (err) {
      this.logCbError("onStatusChange", err);
    }
    return () => this.statusListeners.delete(cb);
  }

  /** Subscribe to latency updates (RTT via ping/pong). Returns an unsubscribe function. */
  onLatency(cb: (ms: number) => void): () => void {
    this.latencyListeners.add(cb);
    if (this.lastLatencyMs != null) {
      try {
        cb(this.lastLatencyMs);
      } catch (err) {
        this.logCbError("onLatency", err);
      }
    }
    return () => this.latencyListeners.delete(cb);
  }

  private setStatus(s: ClientStatusValue) {
    if (this.status === s) return;
    this.status = s;
    const listeners = Array.from(this.statusListeners);
    for (const cb of listeners) {
      try {
        cb(s);
      } catch (err) {
        this.logCbError("onStatusChange", err);
      }
    }
  }

  /** Initiate or resume connection. Resolves when `Connected`. */
  async connect(opts?: { resetBackoff?: boolean }): Promise<void> {
    if (opts?.resetBackoff) {
      this.reconnectAttempts = 0;
    }
    // Ensure future unexpected closes will auto-reconnect again
    this.shouldReconnect = true;
    const current = this.ws;
    if (current) {
      const state = current.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return this.connectedPromise;
      }
    }
    this.clearReconnectTimer();
    // Ensure there's a pending promise for this attempt
    this.ensureConnectedPromise();

    this.setStatus(ClientStatus.Connecting);

    const ws = new WebSocket(this.ops.url);
    this.ws = ws;

    if (current && current !== ws) {
      this.detachSocketListeners(current);
    }

    this.attachSocketListeners(ws);

    ws.binaryType = "arraybuffer";

    return this.connectedPromise;
  }

  private attachSocketListeners(ws: WebSocket): void {
    const open = () => {
      this.onSocketOpen(ws);
    };
    const error = (event: Event) => {
      this.onSocketError(ws, event);
    };
    const close = (event: CloseEvent) => {
      this.onSocketClose(ws, event);
    };
    const message = (event: MessageEvent<string | ArrayBuffer>) => {
      void this.onSocketMessage(ws, event);
    };

    ws.addEventListener("open", open);
    ws.addEventListener("error", error);
    ws.addEventListener("close", close);
    ws.addEventListener("message", message);

    this.socketListeners.set(ws, {
      open,
      error,
      close,
      message,
    });
  }

  private onSocketOpen(ws: WebSocket): void {
    if (ws !== this.ws) {
      // TODO: REVIEW stale sockets bail early so they can't tear down the new connection
      this.detachSocketListeners(ws);
      try {
        ws.close(1000, "Superseded");
      } catch { }
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.setStatus(ClientStatus.Connected);
    this.startPingTimer();
    this.resolveConnected?.();
    // Rejoin rooms after reconnect
    this.rejoinActiveRooms();
    // Flush any queued joins that were requested while connecting
    this.flushQueuedJoins();
  }

  private onSocketError(ws: WebSocket, _event: Event): void {
    if (ws !== this.ws) {
      this.detachSocketListeners(ws);
    }
    // Leave further handling to the close event for the active socket
  }

  private onSocketClose(ws: WebSocket, event?: CloseEvent): void {
    const isCurrent = ws === this.ws;
    this.detachSocketListeners(ws);
    if (!isCurrent) {
      return;
    }

    const closeCode = event?.code;
    const closeReason = event?.reason;

    if (this.isFatalClose(closeCode, closeReason)) {
      this.shouldReconnect = false;
    }

    this.clearPingTimer();
    this.missedPongs = 0;
    // Clear any pending fragment reassembly timers to avoid late callbacks
    if (this.fragmentBatches.size) {
      for (const [, batch] of this.fragmentBatches) {
        clearTimeout(batch.timeoutId);
      }
      this.fragmentBatches.clear();
    }
    // Reset any in-flight RTT probe to allow future pings after reconnect
    this.awaitingPongSince = undefined;
    this.ops.onWsClose?.();
    this.rejectAllPingWaiters(new Error("WebSocket closed"));
    const maxAttempts = this.getReconnectPolicy().maxAttempts;
    if (
      typeof maxAttempts === "number" &&
      maxAttempts > 0 &&
      this.reconnectAttempts >= maxAttempts
    ) {
      this.shouldReconnect = false;
    }

    // Update room-level status based on whether we will retry
    for (const [id] of this.activeRooms) {
      if (this.shouldReconnect) {
        this.emitRoomStatus(id, RoomJoinStatus.Reconnecting);
      } else {
        this.emitRoomStatus(id, RoomJoinStatus.Disconnected);
      }
    }

    if (!this.shouldReconnect) {
      this.setStatus(ClientStatus.Disconnected);
      this.rejectConnected?.(new Error("Disconnected"));
      // Fail all pending joins and mark rooms disconnected/error
      const err = new Error(
        closeReason ? `Disconnected: ${closeReason}` : "Disconnected"
      );
      this.failAllPendingRooms(err, this.shouldReconnect ? RoomJoinStatus.Reconnecting : RoomJoinStatus.Disconnected);
      return;
    }
    // Start (or continue) exponential backoff retries
    this.setStatus(ClientStatus.Disconnected);
    this.scheduleReconnect();
  }

  private async onSocketMessage(
    ws: WebSocket,
    event: MessageEvent<string | ArrayBuffer>
  ): Promise<void> {
    if (ws !== this.ws) {
      return;
    }
    if (typeof event.data === "string") {
      if (event.data === "ping") {
        ws.send("pong");
        return;
      }
      if (event.data === "pong") {
        this.handlePong();
        return;
      }
      return; // ignore other texts
    }
    const dataU8 = new Uint8Array(event.data);
    const msg = tryDecode(dataU8);
    if (msg != null) await this.handleMessage(msg);
  }

  private scheduleReconnect(immediate = false) {
    if (this.reconnectTimer) return;
    if (this.offline) return;
    const policy = this.getReconnectPolicy();
    if (!policy.enabled) return;
    const attempt = ++this.reconnectAttempts;
    const delay = immediate ? 0 : this.computeBackoffDelay(attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private handleOnline = () => {
    this.offline = false;
    if (!this.shouldReconnect) return;
    if (this.status === ClientStatus.Connected) return;
    this.clearReconnectTimer();
    this.scheduleReconnect(true);
  };

  private handleOffline = () => {
    this.offline = true;
    // Pause scheduled retries until online
    this.clearReconnectTimer();
    if (this.shouldReconnect) {
      this.setStatus(ClientStatus.Disconnected);
      try {
        this.ws?.close(1001, "Offline");
      } catch { }
    }
  };

  // Re-send JoinRequest for all active rooms after reconnect
  private rejoinActiveRooms() {
    for (const [id, adaptor] of this.roomAdaptors) {
      const roomId = this.roomIds.get(id);
      if (!roomId) continue;
      const active = this.activeRooms.get(id);
      if (!active) continue;
      // Prepare a lightweight pending entry so JoinError handling can retry version formats
      const roomPromise = Promise.resolve(active.room);
      const pending: PendingRoom = {
        room: roomPromise,
        resolve: (res: JoinResponseOk) => {
          // On successful rejoin, let adaptor reconcile to server
          adaptor
            .handleJoinOk(res)
            .catch(e => {
              console.error(e);
            })
            .finally(() => {
              this.pendingRooms.delete(id);
              this.emitRoomStatus(id, RoomJoinStatus.Joined);
            });
        },
        reject: (error: Error) => {
          console.error("Rejoin failed:", error);
          // Remove stale room entry so callers can decide to rejoin manually
          this.cleanupRoom(roomId, adaptor.crdtType);
          this.emitRoomStatus(id, RoomJoinStatus.Error);
        },
        adaptor,
        roomId,
        auth: this.roomAuth.get(id),
        isRejoin: true,
      };
      this.pendingRooms.set(id, pending);

      try {
        this.ws.send(
          encode({
            type: MessageType.JoinRequest,
            crdt: adaptor.crdtType,
            roomId,
            auth: pending.auth ?? new Uint8Array(),
            version: adaptor.getVersion(),
          } as JoinRequest)
        );
        this.emitRoomStatus(id, RoomJoinStatus.Reconnecting);
      } catch (e) {
        console.error("Failed to send rejoin request:", e);
      }
    }
  }

  private async handleMessage(msg: ProtocolMessage) {
    const roomIdStr = msg.roomId;
    const roomId = msg.crdt + roomIdStr;

    switch (msg.type) {
      case MessageType.JoinRequest: {
        throw new Error("JoinRequest should not be received by client");
      }
      case MessageType.JoinResponseOk: {
        const pending = this.pendingRooms.get(roomId);
        if (pending) {
          pending.resolve(msg);
        }
        break;
      }
      case MessageType.JoinError: {
        const pending = this.pendingRooms.get(roomId);
        if (pending) {
          await this.handleJoinError(msg, pending, roomId);
        }
        break;
      }
      case MessageType.DocUpdate: {
        const active = this.activeRooms.get(roomId);
        if (active) {
          active.handler.handleDocUpdate(msg.updates);
        } else {
          const pending = this.pendingRooms.get(roomId);
          if (pending) {
            const buf = this.preJoinUpdates.get(roomId) ?? [];
            buf.push(...msg.updates);
            this.preJoinUpdates.set(roomId, buf);
          }
        }
        break;
      }
      case MessageType.DocUpdateFragmentHeader: {
        this.handleFragmentHeader(msg);
        break;
      }
      case MessageType.DocUpdateFragment: {
        this.handleFragment(msg);
        break;
      }
      case MessageType.UpdateError: {
        const active = this.activeRooms.get(roomId);
        if (active) {
          active.handler.handleUpdateError(msg);
        } else {
          const roomIdStr = msg.roomId;
          console.error(
            `Update error for room ${roomIdStr}: ${msg.code} - ${msg.message}`
          );
        }
        break;
      }
    }
  }

  private handleFragmentHeader(msg: DocUpdateFragmentHeader) {
    const roomIdStr = msg.roomId;
    const batchKey = `${msg.crdt}-${roomIdStr}-${msg.batchId}`;

    // Clear any existing batch with same ID
    const existing = this.fragmentBatches.get(batchKey);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    // Set up timeout (10 seconds default)
    const timeoutId = setTimeout(() => {
      this.fragmentBatches.delete(batchKey);
      // Send timeout error
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(
            encode({
              type: MessageType.UpdateError,
              crdt: msg.crdt,
              roomId: msg.roomId,
              code: UpdateErrorCode.FragmentTimeout,
              message: `Fragment reassembly timeout for batch ${msg.batchId}`,
            } as UpdateError)
          );
        }
      } catch { }
    }, 10000);

    this.fragmentBatches.set(batchKey, {
      header: msg,
      fragments: new Map(),
      timeoutId,
    });
  }

  private handleFragment(msg: DocUpdateFragment) {
    const roomIdStr = msg.roomId;
    const batchKey = `${msg.crdt}-${roomIdStr}-${msg.batchId}`;
    const batch = this.fragmentBatches.get(batchKey);

    if (!batch) {
      console.error(`Received fragment for unknown batch ${msg.batchId}`);
      return;
    }

    batch.fragments.set(msg.index, msg.fragment);

    // Check if all fragments received
    if (batch.fragments.size === batch.header.fragmentCount) {
      clearTimeout(batch.timeoutId);
      this.fragmentBatches.delete(batchKey);

      // Reassemble fragments
      const reassembledData = new Uint8Array(batch.header.totalSizeBytes);
      let offset = 0;

      // Reassemble in order
      for (let i = 0; i < batch.header.fragmentCount; i++) {
        const fragment = batch.fragments.get(i);
        if (!fragment) {
          console.error(`Missing fragment ${i} in batch ${msg.batchId}`);
          return;
        }

        reassembledData.set(fragment, offset);
        offset += fragment.length;
      }

      // Deliver to room
      const id = msg.crdt + roomIdStr;
      const active = this.activeRooms.get(id);
      if (active) {
        // Treat reassembled data as a single update
        active.handler.handleDocUpdate([reassembledData]);
      } else {
        const pending = this.pendingRooms.get(id);
        if (pending) {
          const buf = this.preJoinUpdates.get(id) ?? [];
          buf.push(reassembledData);
          this.preJoinUpdates.set(id, buf);
        }
      }
    }
  }

  private registerActiveRoom(
    roomId: string,
    crdtType: CrdtType,
    room: LoroWebsocketClientRoom,
    handler: InternalRoomHandler,
    adaptor: CrdtDocAdaptor
  ) {
    const id = crdtType + roomId;
    this.activeRooms.set(id, { room, handler });
    this.roomAdaptors.set(id, adaptor);
    this.roomIds.set(id, roomId);

    // Flush buffered updates if any
    const buf = this.preJoinUpdates.get(id);
    if (buf && buf.length) {
      try {
        handler.handleDocUpdate(buf);
      } finally {
        this.preJoinUpdates.delete(id);
      }
    }

    this.pendingRooms.delete(id);
    this.emitRoomStatus(id, RoomJoinStatus.Joined);
  }

  private async handleJoinError(
    msg: JoinError,
    pending: PendingRoom,
    roomId: string
  ) {
    // First, let adaptor handle the error for custom logic
    await pending.adaptor.handleJoinErr?.(msg);

    if (msg.code === JoinErrorCode.VersionUnknown) {
      // Try alternative version format
      const currentVersion = pending.adaptor.getVersion();
      const alternativeVersion =
        pending.adaptor.getAlternativeVersion?.(currentVersion);
      if (alternativeVersion) {
        // Retry with alternative version format
        this.ws.send(
          encode({
            type: MessageType.JoinRequest,
            crdt: pending.adaptor.crdtType,
            roomId: pending.roomId,
            auth: pending.auth ?? new Uint8Array(),
            version: alternativeVersion,
          } as JoinRequest)
        );
        return;
      } else {
        console.warn("Version unknown. Now join with an empty version");
        this.ws.send(
          encode({
            type: MessageType.JoinRequest,
            crdt: pending.adaptor.crdtType,
            roomId: pending.roomId,
            auth: pending.auth ?? new Uint8Array(),
            version: new Uint8Array(),
          } as JoinRequest)
        );
        return;
      }
    }

    // No retry possible, reject the promise
    const err = new Error(`Join failed: ${msg.code} - ${msg.message}`);
    this.emitRoomStatus(
      pending.adaptor.crdtType + pending.roomId,
      RoomJoinStatus.Error
    );
    // Remove active room references so caller can rejoin manually if this was a rejoin
    if (pending.isRejoin) {
      this.cleanupRoom(pending.roomId, pending.adaptor.crdtType);
    }
    pending.reject(err);
    this.pendingRooms.delete(roomId);
  }

  cleanupRoom(roomId: string, crdtType: CrdtType) {
    const id = crdtType + roomId;
    this.activeRooms.delete(id);
    this.pendingRooms.delete(id);
    this.roomAdaptors.delete(id);
    this.roomIds.delete(id);
    this.roomAuth.delete(id);
    this.roomStatusListeners.delete(id);
  }

  waitConnected() {
    return this.connectedPromise;
  }

  // Send an application-level ping and resolve on matching pong
  async ping(timeoutMs: number = 5000): Promise<void> {
    // Ensure connection
    await this.connectedPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => {
          reject(new Error("Ping timeout"));
        },
        Math.max(1, timeoutMs)
      );

      const waiter = {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      };
      this.pingWaiters.push(waiter);
      try {
        if (this.awaitingPongSince == null) this.awaitingPongSince = Date.now();
        this.ws.send("ping");
      } catch (e) {
        this.pingWaiters.pop();
        clearTimeout(timeoutId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Join a room; `auth` carries application-defined join metadata forwarded to the server.
   */
  join({
    roomId,
    crdtAdaptor,
    auth,
    onStatusChange,
  }: {
    roomId: string;
    crdtAdaptor: CrdtDocAdaptor;
    auth?: Uint8Array;
    onStatusChange?: (s: RoomJoinStatusValue) => void;
  }): Promise<LoroWebsocketClientRoom> {
    const id = crdtAdaptor.crdtType + roomId;
    // Check if already joining or joined
    const pending = this.pendingRooms.get(id);
    if (pending) {
      return pending.room;
    }

    const active = this.activeRooms.get(id);
    if (active) {
      return Promise.resolve(active.room);
    }

    let resolve: (res: JoinResponseOk) => void;
    let reject: (error: Error) => void;

    const response = new Promise<JoinResponseOk>((resolve_, reject_) => {
      resolve = resolve_;
      reject = reject_;
    });

    if (onStatusChange) {
      let set = this.roomStatusListeners.get(id);
      if (!set) {
        set = new Set();
        this.roomStatusListeners.set(id, set);
      }
      set.add(onStatusChange);
    }
    this.emitRoomStatus(id, RoomJoinStatus.Connecting);

    const room = response.then(res => {
      // Set adaptor ctx first so it's ready to send updates
      crdtAdaptor.setCtx({
        send: (updates: Uint8Array[]) => {
          // Send each update individually, fragmenting when necessary
          for (const upd of updates) {
            this.sendUpdateOrFragments(crdtAdaptor.crdtType, roomId, upd);
          }
        },
        onJoinFailed: (reason: string) => {
          console.error(`Join failed: ${reason}`);
          this.ws.send(
            encode({
              type: MessageType.JoinError,
              crdt: crdtAdaptor.crdtType,
              roomId,
              code: JoinErrorCode.AppError,
              message: reason,
            } as JoinError)
          );
          reject(new Error(`Join failed: ${reason}`));
        },
        onImportError: (error: Error, data: Uint8Array[]) => {
          console.error(`Import error: ${error.message}`, data);
          this.ws.send(
            encode({
              type: MessageType.UpdateError,
              crdt: crdtAdaptor.crdtType,
              roomId,
              code: UpdateErrorCode.AppError,
              message: error.message,
            } as UpdateError)
          );
        },
      });
      // Create room and register before invoking adaptor.handleJoinOk to ensure
      // any immediate backfills from the server are routed to the adaptor.
      const { room, handler } = createLoroWebsocketClientRoom({
        client: this,
        roomId,
        crdtType: crdtAdaptor.crdtType,
        crdtAdaptor,
      });
      this.registerActiveRoom(
        roomId,
        crdtAdaptor.crdtType,
        room,
        handler,
        crdtAdaptor
      );
      crdtAdaptor.handleJoinOk(res).catch(e => {
        console.error(e);
      });
      return room;
    });

    this.pendingRooms.set(id, {
      room,
      resolve: resolve!,
      reject: reject!,
      adaptor: crdtAdaptor,
      roomId,
      auth,
    });
    this.roomAuth.set(id, auth);

    const joinPayload = encode({
      type: MessageType.JoinRequest,
      crdt: crdtAdaptor.crdtType,
      roomId,
      auth: auth ?? new Uint8Array(),
      version: crdtAdaptor.getVersion(),
    } as JoinRequest);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(joinPayload);
    } else {
      this.enqueueJoin(joinPayload);
      // ensure a connection attempt is running
      void this.connect();
    }

    return room;
  }

  /**
   * Manually close the connection and stop auto-reconnect.
   * To reconnect later, call `connect()`.
   */
  close() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.reconnectAttempts = 0;
    this.rejectConnected?.(new Error("Disconnected"));
    this.rejectConnected = undefined;
    this.resolveConnected = undefined;
    this.rejectAllPingWaiters(new Error("Disconnected"));
    if (this.fragmentBatches.size) {
      for (const [, batch] of this.fragmentBatches) {
        try {
          clearTimeout(batch.timeoutId);
        } catch { }
      }
      this.fragmentBatches.clear();
    }
    this.awaitingPongSince = undefined;
    const ws = this.ws;
    if (ws && this.socketListeners.has(ws)) {
      this.ops.onWsClose?.();
    }
    this.queuedJoins = [];
    this.detachSocketListeners(ws);
    this.flushAndCloseWebSocket(ws, {
      code: 1000,
      reason: "Client closed",
    });
    this.setStatus(ClientStatus.Disconnected);
  }

  // Fragment and send a single update if it exceeds safe payload size
  private sendUpdateOrFragments(
    crdt: CrdtType,
    roomId: string,
    update: Uint8Array
  ): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // Leave headroom for protocol overhead to stay under MAX_MESSAGE_SIZE
    const FRAG_LIMIT = Math.max(
      1,
      Math.min(240 * 1024, MAX_MESSAGE_SIZE - 4096)
    );

    if (update.length <= FRAG_LIMIT) {
      // Send as a single DocUpdate with one update entry
      ws.send(
        encode({
          type: MessageType.DocUpdate,
          crdt,
          roomId,
          updates: [update],
        } as DocUpdate)
      );
      return;
    }

    // Fragment the update into multiple DocUpdateFragment messages
    const fragmentCount = Math.ceil(update.length / FRAG_LIMIT);
    const batchBytes = new Uint8Array(8); // 8-byte batch ID per protocol
    crypto.getRandomValues(batchBytes);
    const batchId = bytesToHex(batchBytes);

    const header: DocUpdateFragmentHeader = {
      type: MessageType.DocUpdateFragmentHeader,
      crdt,
      roomId,
      batchId,
      fragmentCount,
      totalSizeBytes: update.length,
    };
    ws.send(encode(header));

    for (let i = 0; i < fragmentCount; i++) {
      const start = i * FRAG_LIMIT;
      const end = Math.min(start + FRAG_LIMIT, update.length);
      const fragment = update.subarray(start, end);
      const msg: DocUpdateFragment = {
        type: MessageType.DocUpdateFragment,
        crdt,
        roomId,
        batchId,
        index: i,
        fragment,
      };
      ws.send(encode(msg));
    }
  }

  /** @internal Send Leave on the current websocket. */
  sendLeave(crdt: CrdtType, roomId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      encode({
        type: MessageType.Leave,
        crdt,
        roomId,
      } as Leave)
    );
  }

  /**
   * Destroy the client, removing listeners and stopping timers.
   * After destroy, the instance should not be used.
   */
  destroy(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.reconnectAttempts = 0;
    this.rejectConnected?.(new Error("Destroyed"));
    this.rejectConnected = undefined;
    this.resolveConnected = undefined;
    this.rejectAllPingWaiters(new Error("Destroyed"));
    if (this.fragmentBatches.size) {
      for (const [, batch] of this.fragmentBatches) {
        try {
          clearTimeout(batch.timeoutId);
        } catch { }
      }
      this.fragmentBatches.clear();
    }
    this.awaitingPongSince = undefined;
    const ws = this.ws;
    if (ws && this.socketListeners.has(ws)) {
      this.ops.onWsClose?.();
    }
    this.queuedJoins = [];
    this.detachSocketListeners(ws);
    try {
      this.removeNetworkListeners?.();
    } catch { }
    this.removeNetworkListeners = undefined;
    this.roomStatusListeners.clear();
    // Close websocket after flushing pending frames
    try {
      this.flushAndCloseWebSocket(ws, {
        code: 1000,
        reason: "Client destroyed",
      });
    } catch { }
    this.setStatus(ClientStatus.Disconnected);
  }

  private flushAndCloseWebSocket(
    ws: WebSocket | undefined,
    opts?: { code?: number; reason?: string; timeoutMs?: number }
  ): void {
    if (!ws) return;
    const { code, reason, timeoutMs = 2000 } = opts ?? {};

    const readBufferedAmount = (): number | undefined => {
      const raw = Reflect.get(ws, "bufferedAmount") as unknown;
      return typeof raw === "number" ? raw : undefined;
    };

    if (readBufferedAmount() == null) {
      ws.close(code, reason);
      return;
    }

    const start = Date.now();
    let requested = false;
    const attemptClose = () => {
      if (requested) return;
      const state = ws.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
        requested = true;
        ws.close(code, reason);
        return;
      }

      const buffered = readBufferedAmount();
      if (
        buffered == null ||
        buffered <= 0 ||
        Date.now() - start >= timeoutMs
      ) {
        requested = true;
        ws.close(code, reason);
        return;
      }

      setTimeout(attemptClose, 25);
    };

    attemptClose();
  }

  private detachSocketListeners(ws: WebSocket | undefined): void {
    if (!ws) return;
    const handlers = this.socketListeners.get(ws);
    if (!handlers) return;
    try {
      ws.removeEventListener?.("open", handlers.open);
      ws.removeEventListener?.("error", handlers.error);
      ws.removeEventListener?.("close", handlers.close);
      ws.removeEventListener?.("message", handlers.message);
    } catch { }
    this.socketListeners.delete(ws);
  }

  private startPingTimer(): void {
    const interval = getPingIntervalMs(this.ops);
    if (!interval) return;
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const timeoutMs = Math.max(1, this.ops.pingTimeoutMs ?? 10_000);
      if (
        this.awaitingPongSince != null &&
        now - this.awaitingPongSince > timeoutMs
      ) {
        this.missedPongs += 1;
        this.awaitingPongSince = now;
        if (this.missedPongs >= 2) {
          try {
            this.ws?.close(1001, "ping_timeout");
        } catch (err) {
          this.logCbError("pingTimer close", err);
        }
        return;
      }
    }
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          // Avoid overlapping RTT probes
          if (this.awaitingPongSince == null) {
            this.awaitingPongSince = Date.now();
            this.ws.send("ping");
          } else {
            // Still awaiting a pong; skip sending another ping
          }
        }
      } catch (err) {
        this.logCbError("pingTimer send", err);
      }
    }, interval);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private handlePong(): void {
    // RTT measurement
    if (this.awaitingPongSince != null) {
      const rtt = Date.now() - this.awaitingPongSince;
      if (rtt >= 0 && isFinite(rtt)) {
        this.lastLatencyMs = rtt;
        const listeners = Array.from(this.latencyListeners);
        for (const cb of listeners) {
          try {
            cb(rtt);
          } catch (err) {
            this.logCbError("onLatency", err);
          }
        }
      }
      this.awaitingPongSince = undefined;
    }
    this.missedPongs = 0;
    // Resolve all waiters on any pong
    if (this.pingWaiters.length > 0) {
      const waiters = this.pingWaiters.splice(0, this.pingWaiters.length);
      for (const w of waiters) w.resolve();
    }
  }

  private rejectAllPingWaiters(err: Error): void {
    while (this.pingWaiters.length) {
      const w = this.pingWaiters.shift()!;
      try {
        clearTimeout(w.timeoutId);
        w.reject(err);
      } catch { }
    }
  }

  /** Manual reconnect helper that resets backoff and attempts immediately. */
  retryNow(): Promise<void> {
    return this.connect({ resetBackoff: true });
  }

  private getReconnectPolicy() {
    const p = this.ops.reconnect ?? {};
    return {
      enabled: p.enabled ?? true,
      initialDelayMs: Math.max(1, p.initialDelayMs ?? 500),
      maxDelayMs: Math.max(1, p.maxDelayMs ?? 15_000),
      jitter: Math.max(0, Math.min(1, p.jitter ?? 0.25)),
      maxAttempts: p.maxAttempts ?? "infinite",
      fatalCloseCodes: p.fatalCloseCodes ?? [
        1008,
        1011,
        // 4400-4499
        ...Array.from({ length: 100 }, (_, i) => 4400 + i),
      ],
      fatalCloseReasons: p.fatalCloseReasons ?? [
        "permission_changed",
        "room_closed",
        "auth_failed",
      ],
    };
  }

  private computeBackoffDelay(attempt: number): number {
    const policy = this.getReconnectPolicy();
    const base = policy.initialDelayMs;
    const max = policy.maxDelayMs;
    const raw = base * 2 ** Math.max(0, attempt - 1);
    const jitterFactor =
      1 +
      (policy.jitter === 0
        ? 0
        : (Math.random() * 2 - 1) * policy.jitter);
    const withJitter = raw * jitterFactor;
    return Math.min(max, Math.max(0, Math.floor(withJitter)));
  }

  private logCbError(context: string, err: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[loro-websocket] ${context} callback threw`, err);
  }

  private isFatalClose(code?: number, reason?: string): boolean {
    const policy = this.getReconnectPolicy();
    if (code != null && policy.fatalCloseCodes.includes(code)) return true;
    if (reason && policy.fatalCloseReasons.includes(reason)) return true;
    return false;
  }

  private enqueueJoin(payload: Uint8Array) {
    this.queuedJoins.push(payload);
  }

  private flushQueuedJoins() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.queuedJoins.length) return;
    const items = this.queuedJoins.splice(0, this.queuedJoins.length);
    for (const payload of items) {
      try {
        this.ws.send(payload);
      } catch (e) {
        console.error("Failed to flush queued join:", e);
      }
    }
  }

  private emitRoomStatus(roomKey: string, status: RoomJoinStatusValue) {
    const set = this.roomStatusListeners.get(roomKey);
    if (!set || set.size === 0) return;
    for (const cb of Array.from(set)) {
      try {
        cb(status);
      } catch (err) {
        this.logCbError("onRoomStatusChange", err);
      }
    }
  }

  private failAllPendingRooms(err: Error, status: RoomJoinStatusValue) {
    const entries = Array.from(this.pendingRooms.entries());
    for (const [id, pending] of entries) {
      try {
        this.emitRoomStatus(id, status);
      } catch { }
      try {
        pending.reject(err);
      } catch { }
      try {
        this.cleanupRoom(pending.roomId, pending.adaptor.crdtType);
      } catch { }
      this.pendingRooms.delete(id);
    }
  }
}

export interface LoroWebsocketClientRoom {
  /**
   * Leave the room.
   */
  leave(): Promise<void>;
  /**
   * This method returns a promise that resolves when the client document version is >= the server's version.
   */
  waitForReachingServerVersion(): Promise<void>;
  destroy(): Promise<void>;
}

class LoroWebsocketClientRoomImpl
  implements LoroWebsocketClientRoom, InternalRoomHandler {
  private client: LoroWebsocketClient;
  private roomId: string;
  private crdtType: CrdtType;
  private crdtAdaptor: CrdtDocAdaptor;
  private destroyed: boolean = false;
  private unsubscribe: (() => void)[] = [];

  constructor(opts: {
    client: LoroWebsocketClient;
    roomId: string;
    crdtType: CrdtType;
    crdtAdaptor: CrdtDocAdaptor;
  }) {
    this.client = opts.client;
    this.roomId = opts.roomId;
    this.crdtType = opts.crdtType;
    this.crdtAdaptor = opts.crdtAdaptor;

    // Room lifetime is controlled explicitly by leave()/destroy().
    // Do not auto-destroy on underlying ws close; client handles reconnects.
  }

  /**
   * This method returns a promise that resolves when the client document version is >= the server's version.
   */
  async waitForReachingServerVersion(): Promise<void> {
    return this.crdtAdaptor.waitForReachingServerVersion();
  }

  handleDocUpdate(updates: Uint8Array[]) {
    this.crdtAdaptor.applyUpdate(updates);
  }

  handleUpdateError(error: UpdateError) {
    this.crdtAdaptor.handleUpdateError?.(error);
  }

  async leave() {
    if (this.destroyed) {
      return;
    }

    // Send Leave message
    // Use client's current websocket to ensure it works across reconnects
    this.client.sendLeave(this.crdtType, this.roomId);
  }

  async destroy() {
    if (this.destroyed) {
      return;
    }

    await this.leave();
    this.destroyed = true;
    this.crdtAdaptor.destroy();
    this.unsubscribe.forEach(fn => {
      fn();
    });
    this.unsubscribe = [];

    // Unregister from client
    this.client.cleanupRoom(this.roomId, this.crdtType);
  }
}

// --- Keepalive helpers (ping/pong) ---

// --- Internal ping helpers ---
function isPositive(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v > 0;
}

// Use default 30s unless disabled
function getPingIntervalMs(opts: {
  pingIntervalMs?: number;
  disablePing?: boolean;
}): number | undefined {
  if (opts.disablePing) return undefined;
  const v = opts.pingIntervalMs;
  if (isPositive(v)) return v;
  return 30_000;
}

function createLoroWebsocketClientRoom(opts: {
  client: LoroWebsocketClient;
  roomId: string;
  crdtType: CrdtType;
  crdtAdaptor: CrdtDocAdaptor;
}): { room: LoroWebsocketClientRoom; handler: InternalRoomHandler } {
  const impl = new LoroWebsocketClientRoomImpl(opts);
  return {
    room: impl,
    handler: impl,
  };
}
