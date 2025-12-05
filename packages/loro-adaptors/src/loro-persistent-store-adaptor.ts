import { EphemeralStore } from "loro-crdt";
import { CrdtType, JoinResponseOk } from "loro-protocol";
import type { CrdtAdaptorContext, CrdtDocAdaptor } from "./types";

export class LoroPersistentStoreAdaptor implements CrdtDocAdaptor {
  readonly crdtType = CrdtType.LoroEphemeralStorePersisted;

  private store: EphemeralStore;
  private ctx?: CrdtAdaptorContext;
  private localUpdateUnsubscribe?: () => void;
  private destroyed = false;

  constructor(store?: EphemeralStore) {
    this.store = store || new EphemeralStore();
  }

  waitForReachingServerVersion(): Promise<void> {
    return Promise.resolve();
  }

  cmpVersion(_v: Uint8Array) {
    return 0 as const;
  }

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
          this.ctx?.onImportError(
            error instanceof Error ? error : new Error(String(error)),
            [update]
          );
        }
      }
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
