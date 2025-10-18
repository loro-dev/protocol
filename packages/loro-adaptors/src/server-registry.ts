import { CrdtType } from "loro-protocol";
import type { AdaptorsForServer, CrdtServerAdaptor } from "./types";

class InMemoryAdaptorsForServer implements AdaptorsForServer {
  private readonly adaptors = new Map<CrdtType, CrdtServerAdaptor>();

  register(adaptor: CrdtServerAdaptor): void {
    this.adaptors.set(adaptor.crdtType, adaptor);
  }

  registerMany(adaptors: Iterable<CrdtServerAdaptor>): void {
    for (const adaptor of adaptors) {
      this.register(adaptor);
    }
  }

  get(crdtType: CrdtType): CrdtServerAdaptor | undefined {
    return this.adaptors.get(crdtType);
  }

  clear(): void {
    this.adaptors.clear();
  }

  list(): CrdtServerAdaptor[] {
    return Array.from(this.adaptors.values());
  }
}

export const adaptorsForServer: AdaptorsForServer = new InMemoryAdaptorsForServer();

export function registerServerAdaptor(adaptor: CrdtServerAdaptor): void {
  adaptorsForServer.register(adaptor);
}

export function registerServerAdaptors(adaptors: Iterable<CrdtServerAdaptor>): void {
  adaptorsForServer.registerMany(adaptors);
}

export function getServerAdaptor(crdtType: CrdtType): CrdtServerAdaptor | undefined {
  return adaptorsForServer.get(crdtType);
}

export function clearServerAdaptors(): void {
  adaptorsForServer.clear();
}

export function listServerAdaptors(): CrdtServerAdaptor[] {
  return adaptorsForServer.list();
}
