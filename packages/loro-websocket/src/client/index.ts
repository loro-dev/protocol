import {
  CrdtType,
  ProtocolMessage,
  tryDecode,
  MessageType,
  JoinResponseOk,
  encode,
  JoinRequest,
  DocUpdate,
  DocUpdateV2,
  JoinError,
  DocUpdateFragmentHeader,
  DocUpdateFragment,
  Ack,
  UpdateError,
  UpdateErrorV2,
  UpdateErrorCode,
  Leave,
  JoinErrorCode,
  MAX_MESSAGE_SIZE,
  bytesToHex,
  type HexString,
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
}

interface InternalRoomHandler {
  handleDocUpdate(updates: Uint8Array[]): void;
  handleUpdateError(error: UpdateError | UpdateErrorV2): void;
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
  /** Disable periodic ping/pong entirely. */
  disablePing?: boolean;
  /** Optional callback for low-level ws close (before status transitions). */
  onWsClose?: () => void;
}

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
  private socketListeners = new WeakMap<WebSocket, SocketListeners>();

  private pingTimer?: ReturnType<typeof setInterval>;
  private pingWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];

  // Reconnect controls
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private removeNetworkListeners?: () => void;

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
    } catch {}
    return () => this.statusListeners.delete(cb);
  }

  /** Subscribe to latency updates (RTT via ping/pong). Returns an unsubscribe function. */
  onLatency(cb: (ms: number) => void): () => void {
    this.latencyListeners.add(cb);
    if (this.lastLatencyMs != null) {
      try {
        cb(this.lastLatencyMs);
      } catch {}
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
      } catch {}
    }
  }

  /** Initiate or resume connection. Resolves when `Connected`. */
  async connect(): Promise<void> {
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

    try {
      ws.binaryType = "arraybuffer";
    } catch {}

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
      } catch {}
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.setStatus(ClientStatus.Connected);
    this.startPingTimer();
    this.resolveConnected?.();
    // Rejoin rooms after reconnect
    this.rejoinActiveRooms();
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
    if (closeCode != null && closeCode >= 4400 && closeCode < 4500) {
      this.shouldReconnect = false;
    }

    const closeReason = event?.reason;
    if (closeReason === "permission_changed" || closeReason === "room_closed") {
      this.shouldReconnect = false;
    }

    this.clearPingTimer();
    // Clear any pending fragment reassembly timers to avoid late callbacks
    if (this.fragmentBatches.size) {
      for (const [, batch] of this.fragmentBatches) {
        try {
          clearTimeout(batch.timeoutId);
        } catch {}
      }
      this.fragmentBatches.clear();
    }
    // Reset any in-flight RTT probe to allow future pings after reconnect
    this.awaitingPongSince = undefined;
    this.ops.onWsClose?.();
    this.rejectAllPingWaiters(new Error("WebSocket closed"));
    if (!this.shouldReconnect) {
      this.setStatus(ClientStatus.Disconnected);
      this.rejectConnected?.(new Error("Disconnected"));
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
        try {
          ws.send("pong");
        } catch {}
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
    const attempt = ++this.reconnectAttempts;
    const base = 500; // ms
    const max = 15_000; // ms
    const delay = immediate ? 0 : Math.min(max, base * 2 ** (attempt - 1));
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
    if (!this.shouldReconnect) return;
    if (this.status === ClientStatus.Connected) return;
    this.clearReconnectTimer();
    this.scheduleReconnect(true);
  };

  private handleOffline = () => {
    // Pause scheduled retries until online
    this.clearReconnectTimer();
    if (this.shouldReconnect) {
      this.setStatus(ClientStatus.Disconnected);
      try {
        this.ws?.close(1001, "Offline");
      } catch {}
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
          adaptor.handleJoinOk(res).catch(e => {
            console.error(e);
          });
          // Clean up pending entry for this id
          this.pendingRooms.delete(id);
        },
        reject: (error: Error) => {
          console.error("Rejoin failed:", error);
        },
        adaptor,
        roomId,
        auth: this.roomAuth.get(id),
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
      case MessageType.DocUpdateV2: {
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
        this.sendAck(msg.batchId, msg.crdt, msg.roomId);
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
      case MessageType.UpdateError:
      case MessageType.UpdateErrorV2: {
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
      case MessageType.Ack: {
        // Currently no explicit ack tracking on client; ignore.
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
      this.sendUpdateErrorV2(
        msg.batchId,
        msg.crdt,
        msg.roomId,
        UpdateErrorCode.FragmentTimeout,
        `Fragment reassembly timeout for batch ${msg.batchId}`
      );
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
      this.sendUpdateErrorV2(
        msg.batchId,
        msg.crdt,
        msg.roomId,
        UpdateErrorCode.InvalidUpdate,
        `Unknown fragment batch ${msg.batchId}`
      );
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
        this.sendAck(msg.batchId, msg.crdt, msg.roomId);
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
    pending.reject(new Error(`Join failed: ${msg.code} - ${msg.message}`));
    this.pendingRooms.delete(roomId);
  }

  cleanupRoom(roomId: string, crdtType: CrdtType) {
    const id = crdtType + roomId;
    this.activeRooms.delete(id);
    this.pendingRooms.delete(id);
    this.roomAdaptors.delete(id);
    this.roomIds.delete(id);
    this.roomAuth.delete(id);
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
  }: {
    roomId: string;
    crdtAdaptor: CrdtDocAdaptor;
    auth?: Uint8Array;
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

    this.ws.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: crdtAdaptor.crdtType,
        roomId,
        auth: auth ?? new Uint8Array(),
        version: crdtAdaptor.getVersion(),
      } as JoinRequest)
    );

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
        } catch {}
      }
      this.fragmentBatches.clear();
    }
    this.awaitingPongSince = undefined;
    const ws = this.ws;
    if (ws && this.socketListeners.has(ws)) {
      this.ops.onWsClose?.();
    }
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
      // Send as a single DocUpdateV2 with one update entry
      const batchId = this.generateBatchId();
      ws.send(
        encode({
          type: MessageType.DocUpdateV2,
          crdt,
          roomId,
          batchId,
          updates: [update],
        } as DocUpdateV2)
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

  private sendAck(batchId: HexString, crdt: CrdtType, roomId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        encode({
          type: MessageType.Ack,
          crdt,
          roomId,
          batchId,
        } as Ack)
      );
    } catch (err) {
      console.error("Failed to send ACK", err);
    }
  }

  private sendUpdateErrorV2(
    batchId: HexString,
    crdt: CrdtType,
    roomId: string,
    code: UpdateErrorCode,
    message: string
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        encode({
          type: MessageType.UpdateErrorV2,
          crdt,
          roomId,
          batchId,
          code,
          message,
        } as UpdateErrorV2)
      );
    } catch (err) {
      console.error("Failed to send UpdateErrorV2", err);
    }
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
        } catch {}
      }
      this.fragmentBatches.clear();
    }
    this.awaitingPongSince = undefined;
    const ws = this.ws;
    if (ws && this.socketListeners.has(ws)) {
      this.ops.onWsClose?.();
    }
    this.detachSocketListeners(ws);
    try {
      this.removeNetworkListeners?.();
    } catch {}
    this.removeNetworkListeners = undefined;
    // Close websocket after flushing pending frames
    try {
      this.flushAndCloseWebSocket(ws, {
        code: 1000,
        reason: "Client destroyed",
      });
    } catch {}
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
      try {
        ws.close(code, reason);
      } catch {}
      return;
    }

    const start = Date.now();
    let requested = false;
    const attemptClose = () => {
      if (requested) return;
      const state = ws.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
        requested = true;
        try {
          ws.close(code, reason);
        } catch {}
        return;
      }

      const buffered = readBufferedAmount();
      if (
        buffered == null ||
        buffered <= 0 ||
        Date.now() - start >= timeoutMs
      ) {
        requested = true;
        try {
          ws.close(code, reason);
        } catch {}
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
    } catch {}
    this.socketListeners.delete(ws);
  }

  private startPingTimer(): void {
    const interval = getPingIntervalMs(this.ops);
    if (!interval) return;
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
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
      } catch {}
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
          } catch {}
        }
      }
      this.awaitingPongSince = undefined;
    }
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
      } catch {}
    }
  }

  private generateBatchId(): HexString {
    const buf = new Uint8Array(8);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytesToHex(buf);
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
  implements LoroWebsocketClientRoom, InternalRoomHandler
{
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
