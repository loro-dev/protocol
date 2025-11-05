import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoroDoc, EphemeralStore, VersionVector } from "loro-crdt";
import {
  LoroAdaptor,
  LoroEphemeralAdaptor,
  LoroPersistentStoreAdaptor,
} from "../src/adaptors";
import { CrdtType, JoinResponseOk, MessageType } from "loro-protocol";

describe("LoroAdaptor", () => {
  let adaptor: LoroAdaptor;
  let doc: LoroDoc;

  beforeEach(() => {
    doc = new LoroDoc();
    adaptor = new LoroAdaptor(doc);
  });

  it("should have correct CRDT type", () => {
    expect(adaptor.crdtType).toBe(CrdtType.Loro);
  });

  it("should return the underlying LoroDoc", () => {
    expect(adaptor.getDoc()).toBe(doc);
  });

  it("should get version as encoded VersionVector", () => {
    const version = adaptor.getVersion();
    expect(version).toBeInstanceOf(Uint8Array);

    const decoded = VersionVector.decode(version);
    expect(decoded).toBeInstanceOf(VersionVector);
  });

  it("should handle setCtx and subscribe to local updates", () => {
    const mockSend = vi.fn();
    adaptor.setCtx({
      send: mockSend,
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    doc.getText("test").insert(0, "hello");
    doc.commit();

    expect(mockSend).toHaveBeenCalled();
  });

  it("should handle join ok and send missing updates", async () => {
    doc.getText("test").insert(0, "hello");
    doc.commit();

    const serverVersion = new VersionVector(new Map());
    const joinOk: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId: "test-room",
      permission: "write",
      version: serverVersion.encode(),
    };

    const mockSend = vi.fn();
    adaptor.setCtx({
      send: mockSend,
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    await adaptor.handleJoinOk(joinOk);

    expect(mockSend).toHaveBeenCalledWith([expect.any(Uint8Array)]);
  });

  it("should apply valid updates", () => {
    const otherDoc = new LoroDoc();
    otherDoc.getText("test").insert(0, "hello");
    const update = otherDoc.export({ mode: "update" });

    adaptor.applyUpdate([update]);

    expect(doc.getText("test").toString()).toBe("hello");
  });
});

describe("LoroEphemeralAdaptor", () => {
  let adaptor: LoroEphemeralAdaptor;
  let store: EphemeralStore;

  beforeEach(() => {
    store = new EphemeralStore();
    adaptor = new LoroEphemeralAdaptor(store);
  });

  it("should have correct CRDT type", () => {
    expect(adaptor.crdtType).toBe(CrdtType.LoroEphemeralStore);
  });

  it("should return the underlying EphemeralStore", () => {
    expect(adaptor.getStore()).toBe(store);
  });

  it("should get empty version", () => {
    const version = adaptor.getVersion();
    expect(version).toBeInstanceOf(Uint8Array);
    expect(version.length).toBe(0);
  });

  it("should handle setCtx and subscribe to local updates", () => {
    const mockSend = vi.fn();
    adaptor.setCtx({
      send: mockSend,
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    store.set("cursor", { x: 10, y: 20 });

    expect(mockSend).toHaveBeenCalled();
  });

  it("should apply ephemeral updates", () => {
    const otherStore = new EphemeralStore();
    otherStore.set("cursor", { x: 100, y: 200 });
    const update = otherStore.encodeAll();

    adaptor.applyUpdate([update]);

    expect(store.get("cursor")).toEqual({ x: 100, y: 200 });
  });
});

describe("LoroPersistentStoreAdaptor", () => {
  let adaptor: LoroPersistentStoreAdaptor;
  let store: EphemeralStore;

  beforeEach(() => {
    store = new EphemeralStore();
    adaptor = new LoroPersistentStoreAdaptor(store);
  });

  it("should have correct CRDT type", () => {
    expect(adaptor.crdtType).toBe(CrdtType.LoroEphemeralStorePersisted);
  });

  it("should return the underlying EphemeralStore", () => {
    expect(adaptor.getStore()).toBe(store);
  });

  it("should send full state on join", async () => {
    const mockSend = vi.fn();
    adaptor.setCtx({
      send: mockSend,
      onJoinFailed: vi.fn(),
      onImportError: vi.fn(),
    });

    store.set("cursor", { x: 1 });
    const joinOk: JoinResponseOk = {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.LoroEphemeralStorePersisted,
      roomId: "room",
      permission: "write",
      version: new Uint8Array(),
    };

    await adaptor.handleJoinOk(joinOk);

    expect(mockSend).toHaveBeenCalledWith([expect.any(Uint8Array)]);
  });
});

describe("Utility functions", () => {
  it("should create LoroAdaptor with new LoroDoc", () => {
    const adaptor = new LoroAdaptor();
    expect(adaptor).toBeInstanceOf(LoroAdaptor);
    expect(adaptor.getDoc()).toBeInstanceOf(LoroDoc);
  });
});
