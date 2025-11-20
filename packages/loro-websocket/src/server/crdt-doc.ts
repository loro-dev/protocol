import type { CrdtServerAdaptor } from "loro-adaptors";
import { LoroServerAdaptor, LoroEphemeralServerAdaptor, LoroPersistentStoreServerAdaptor } from "loro-adaptors/loro";
import { FlockServerAdaptor } from "loro-adaptors/flock";
import { CrdtType } from "loro-protocol";
import { EloServerAdaptor } from "./elo-server-adaptor";

export interface ServerAdaptorDescriptor {
  adaptor: CrdtServerAdaptor;
  shouldPersist: boolean;
  allowBackfillWhenNoOtherClients: boolean;
}

const descriptors = new Map<CrdtType, ServerAdaptorDescriptor>();

function registerDescriptor(descriptor: ServerAdaptorDescriptor): void {
  descriptors.set(descriptor.adaptor.crdtType, descriptor);
}

const defaultDescriptors: ServerAdaptorDescriptor[] = [
  {
    adaptor: new LoroServerAdaptor(),
    shouldPersist: true,
    allowBackfillWhenNoOtherClients: true,
  },
  {
    adaptor: new LoroEphemeralServerAdaptor(),
    shouldPersist: false,
    allowBackfillWhenNoOtherClients: false,
  },
  {
    adaptor: new LoroPersistentStoreServerAdaptor(),
    shouldPersist: true,
    allowBackfillWhenNoOtherClients: true,
  },
  {
    adaptor: new FlockServerAdaptor(),
    shouldPersist: true,
    allowBackfillWhenNoOtherClients: false,
  },
  {
    adaptor: new EloServerAdaptor(),
    shouldPersist: false,
    allowBackfillWhenNoOtherClients: true,
  },
];

for (const descriptor of defaultDescriptors) {
  registerDescriptor(descriptor);
}

export function registerServerAdaptorDescriptor(
  descriptor: ServerAdaptorDescriptor
): void {
  registerDescriptor(descriptor);
}

export function getServerAdaptorDescriptor(
  crdtType: CrdtType
): ServerAdaptorDescriptor | undefined {
  return descriptors.get(crdtType);
}
