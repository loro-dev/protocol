import {
  CrdtType,
  JoinResponseOk,
  JoinError,
  UpdateError,
  Permission,
} from "loro-protocol";

export interface CrdtDocAdaptor {
  crdtType: CrdtType;
  /**
   * We'll call this method before all the other methods, so that the adaptor can send updates
   * @param ctx
   */
  setCtx(ctx: CrdtAdaptorContext): void;
  /**
   * This method is called when the client receives a JoinResponseOk message from the server.
   * The adaptor then should send the updates missing from the server's version.
   * @param res
   */
  handleJoinOk: (res: JoinResponseOk) => Promise<void>;
  /**
   * This method should return a promise that resolves when the client document version >= the server's version.
   * @returns A promise that resolves when the client document version >= the server's version.
   */
  waitForReachingServerVersion: () => Promise<void>;
  /**
   * This method is called when the client receives a DocUpdate message from the server.
   * The adaptor then should apply the updates to the document.
   * @param updates
   */
  applyUpdate: (updates: Uint8Array[]) => void;
  /**
   * Compare the document version with the current version
   * @param v The version to compare with
   * @returns 0 if the versions are equal, 1 if the version is greater, -1 if the version is less, undefined if the version is concurrent
   */
  cmpVersion(v: Uint8Array): 0 | 1 | -1 | undefined;
  getVersion: () => Uint8Array;
  /**
   * Get alternative version format for retry attempt
   * @param currentVersion The version that failed
   * @returns Alternative version to try, or undefined if no alternatives
   */
  getAlternativeVersion?: (
    currentVersion: Uint8Array
  ) => Uint8Array | undefined;
  /**
   * Handle update errors with context-specific logic
   * @param error The update error details
   */
  handleUpdateError?: (error: UpdateError) => void;
  handleJoinErr?: (err: JoinError) => Promise<void>;
  destroy: () => void;
}

export interface CrdtAdaptorContext {
  send: (updates: Uint8Array[]) => void;
  onJoinFailed: (reason: string) => void;
  onImportError: (error: Error, data: Uint8Array[]) => void;
}

export interface CrdtServerAdaptor {
  readonly crdtType: CrdtType;

  createEmpty(): Uint8Array;

  handleJoinRequest(
    documentData: Uint8Array,
    clientVersion: Uint8Array,
    permission: Permission
  ): {
    response: JoinResponseOk;
    updates?: Uint8Array[];
  };

  applyUpdates(
    documentData: Uint8Array,
    updates: Uint8Array[],
    permission: Permission
  ): {
    success: boolean;
    newDocumentData?: Uint8Array;
    error?: UpdateError;
    broadcastUpdates?: Uint8Array[];
  };

  getVersion(documentData: Uint8Array): Uint8Array;

  getSize(documentData: Uint8Array): number;

  merge(documents: Uint8Array[]): Uint8Array;
}

export interface AdaptorsForServer {
  register(adaptor: CrdtServerAdaptor): void;
  registerMany(adaptors: Iterable<CrdtServerAdaptor>): void;
  get(crdtType: CrdtType): CrdtServerAdaptor | undefined;
  clear(): void;
  list(): CrdtServerAdaptor[];
}
