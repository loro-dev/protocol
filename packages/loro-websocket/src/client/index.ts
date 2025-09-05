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
}

interface InternalRoomHandler {
  handleDocUpdate(updates: Uint8Array[]): void;
  handleUpdateError(error: UpdateError): void;
}

interface ActiveRoom {
  room: LoroWebsocketClientRoom;
  handler: InternalRoomHandler;
}

export class LoroWebsocketClient {
  private ws!: WebSocket;
  private connectedPromise: Promise<void>;
  private pendingRooms: Map<string, PendingRoom> = new Map();
  private activeRooms: Map<string, ActiveRoom> = new Map();
  // Buffer for %ELO only: backfills can arrive immediately after JoinResponseOk
  private preJoinUpdates: Map<string, Uint8Array[]> = new Map();
  private fragmentBatches: Map<string, FragmentBatch> = new Map();
  private roomAdaptors: Map<string, CrdtDocAdaptor> = new Map();
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private ops: { url: string; pingIntervalMs?: number; disablePing?: boolean }
  ) {
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.ops.url);
      // Ensure binary frames surface as ArrayBuffer for consistent handling
      try {
        this.ws.binaryType = "arraybuffer";
      } catch { }
      this.ws.addEventListener('open', () => {
        this.startPingTimer();
        resolve();
      });
      this.ws.addEventListener('error', () => {
        reject(new Error("WebSocket connection failed"));
      });
      this.ws.addEventListener('message', async (event: MessageEvent<string | ArrayBuffer>) => {
        // Keepalive handling: respond to "ping" text, ignore/fulfill on "pong"
        if (typeof event.data === "string") {
          if (event.data === "ping") {
            this.ws.send("pong");
            return;
          }
          if (event.data === "pong") {
            this.handlePong();
            return;
          }
          // Ignore other unexpected text frames
          return;
        }

        const dataU8 = new Uint8Array(event.data);
        const msg = tryDecode(dataU8);
        if (msg != null) await this.handleMessage(msg);
      });
    });

    // Clear timers and pending waiters on close
    this.ws.addEventListener('close', () => {
      this.clearPingTimer();
      this.rejectAllPingWaiters(new Error("WebSocket closed"));
    });
  }

  private async handleMessage(msg: ProtocolMessage) {
    const roomIdStr =
      typeof msg.roomId === "string"
        ? msg.roomId
        : new TextDecoder().decode(msg.roomId);
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
          if (pending && pending.adaptor.crdtType === CrdtType.Elo) {
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
          const roomIdStr =
            typeof msg.roomId === "string"
              ? msg.roomId
              : new TextDecoder().decode(msg.roomId);
          console.error(
            `Update error for room ${roomIdStr}: ${msg.code} - ${msg.message}`
          );
        }
        break;
      }
    }
  }

  private handleFragmentHeader(msg: DocUpdateFragmentHeader) {
    const roomIdStr =
      typeof msg.roomId === "string"
        ? msg.roomId
        : new TextDecoder().decode(msg.roomId);
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
      this.ws.send(
        encode({
          type: MessageType.UpdateError,
          crdt: msg.crdt,
          roomId: msg.roomId,
          code: UpdateErrorCode.FragmentTimeout,
          message: `Fragment reassembly timeout for batch ${msg.batchId}`,
        } as UpdateError)
      );
    }, 10000);

    this.fragmentBatches.set(batchKey, {
      header: msg,
      fragments: new Map(),
      timeoutId,
    });
  }

  private handleFragment(msg: DocUpdateFragment) {
    const roomIdStr =
      typeof msg.roomId === "string"
        ? msg.roomId
        : new TextDecoder().decode(msg.roomId);
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
        if (pending && pending.adaptor.crdtType === CrdtType.Elo) {
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

    // Flush buffered %ELO updates if any
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
        this.ws.send("ping");
      } catch (e) {
        this.pingWaiters.pop();
        clearTimeout(timeoutId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

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
        ws: this.ws,
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

  close() {
    // TODO: impl
  }

  // Fragment and send a single update if it exceeds safe payload size
  private sendUpdateOrFragments(
    crdt: CrdtType,
    roomId: string,
    update: Uint8Array
  ): void {
    // Leave headroom for protocol overhead to stay under MAX_MESSAGE_SIZE
    const FRAG_LIMIT = Math.max(
      1,
      Math.min(240 * 1024, MAX_MESSAGE_SIZE - 4096)
    );

    if (update.length <= FRAG_LIMIT) {
      // Send as a single DocUpdate with one update entry
      this.ws.send(
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
    this.ws.send(encode(header));

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
      this.ws.send(encode(msg));
    }
  }

  private startPingTimer(): void {
    const interval = getPingIntervalMs(this.ops);
    if (!interval) return;
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("ping");
        }
      } catch { }
    }, interval);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private handlePong(): void {
    if (this.pingWaiters.length === 0) return;
    // Resolve all waiters on any pong
    const waiters = this.pingWaiters.splice(0, this.pingWaiters.length);
    for (const w of waiters) w.resolve();
  }

  private rejectAllPingWaiters(err: Error): void {
    while (this.pingWaiters.length) {
      const w = this.pingWaiters.shift()!;
      try {
        w.reject(err);
      } catch { }
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
  private ws: WebSocket | undefined;
  private client: LoroWebsocketClient;
  private roomId: string;
  private crdtType: CrdtType;
  private crdtAdaptor: CrdtDocAdaptor;
  private destroyed: boolean = false;
  private unsubscribe: (() => void)[] = [];

  constructor(opts: {
    ws: WebSocket;
    client: LoroWebsocketClient;
    roomId: string;
    crdtType: CrdtType;
    crdtAdaptor: CrdtDocAdaptor;
  }) {
    this.ws = opts.ws;
    this.client = opts.client;
    this.roomId = opts.roomId;
    this.crdtType = opts.crdtType;
    this.crdtAdaptor = opts.crdtAdaptor;

    const onDestroy = () => {
      void this.destroy();
    };
    this.ws.addEventListener("close", onDestroy);
    this.unsubscribe.push(() => {
      this.ws?.removeEventListener("close", onDestroy);
    });
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
    if (this.destroyed || !this.ws) {
      return;
    }

    // Send Leave message
    this.ws.send(
      encode({
        type: MessageType.Leave,
        crdt: this.crdtType,
        roomId: this.roomId,
      } as Leave)
    );
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

    this.ws = undefined;
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
  ws: WebSocket;
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
