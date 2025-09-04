import { EphemeralStore } from "loro-crdt";
import { CrdtType, JoinResponseOk, UpdateError } from "loro-protocol";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "./types";

export interface LoroEphemeralAdaptorConfig {
  timeout?: number;
  onUpdateError?: (error: UpdateError) => void;
}

export class LoroEphemeralAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStore;

  private store: EphemeralStore;
  private config: LoroEphemeralAdaptorConfig;
  private ctx?: CrdtAdaptorContext;
  private localUpdateUnsubscribe?: () => void;
  private destroyed = false;

  constructor(store?: EphemeralStore, config: LoroEphemeralAdaptorConfig = {}) {
    this.store = store || new EphemeralStore(config.timeout);
    this.config = config;
  }

  waitForReachingServerVersion(): Promise<void> {
    return Promise.resolve();
  }

  cmpVersion(_v: Uint8Array) {
    return 0 as const;
  }

  handleJoinErr?: undefined;

  getStore(): EphemeralStore {
    return this.store;
  }

  setCtx(ctx: CrdtAdaptorContext): void {
    this.ctx = ctx;
    this.localUpdateUnsubscribe = this.store.subscribeLocalUpdates(updates => {
      if (!this.destroyed && this.ctx) {
        this.ctx.send([updates]);
      }
    });
  }

  getVersion(): Uint8Array {
    return new Uint8Array();
  }

  getAlternativeVersion(_currentVersion: Uint8Array): Uint8Array | undefined {
    return undefined;
  }

  async handleJoinOk(_res: JoinResponseOk): Promise<void> {
    if (this.destroyed) return;
    if (this.ctx) {
      const allState = this.store.encodeAll();
      if (allState.length > 0) {
        this.ctx.send([allState]);
      }
    }
  }

  applyUpdate(updates: Uint8Array[]): void {
    if (this.destroyed || !updates?.length) return;
    for (const update of updates) {
      if (update?.length > 0) {
        try {
          this.store.apply(update);
        } catch (error) {
          this.ctx?.onImportError(error instanceof Error ? error : new Error(String(error)), [update]);
        }
      }
    }
  }

  handleUpdateError(error: UpdateError): void {
    if (this.config.onUpdateError) {
      this.config.onUpdateError(error);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.localUpdateUnsubscribe) {
      this.localUpdateUnsubscribe();
      this.localUpdateUnsubscribe = undefined;
    }

    this.store.destroy();
    this.ctx = undefined;
  }
}

export function createLoroEphemeralAdaptor(config: LoroEphemeralAdaptorConfig = {}): LoroEphemeralAdaptor {
  return new LoroEphemeralAdaptor(new EphemeralStore(config.timeout), config);
}

export function createLoroEphemeralAdaptorFromStore(
  store: EphemeralStore,
  config: LoroEphemeralAdaptorConfig = {}
): LoroEphemeralAdaptor {
  return new LoroEphemeralAdaptor(store, config);
}

