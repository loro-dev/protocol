import { useEffect, useRef, useCallback, useState } from "react";
import { throttle } from "throttle-debounce"; // TODO: REVIEW [stability] replace custom throttle with lib
import {
  LoroDoc,
  EphemeralStore,
  LoroEventBatch,
  LoroMap,
  type Value,
} from "loro-crdt";
import { LoroWebsocketClient } from "loro-websocket/client";
import { LoroAdaptor, LoroEphemeralAdaptor } from "loro-adaptors";
import type {
  AppState as ExcalidrawAppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";

interface UseLoroSyncOptions {
  roomId: string;
  userId: string;
  userName: string;
  userColor: string;
  wsUrl: string;
  excalidrawAPI: React.RefObject<ExcalidrawImperativeAPI>;
}

interface PresenceEntry extends Record<string, Value> {
  userId: string;
  userName: string;
  userColor: string;
  cursor?: CursorPosition;
  selectedElementIds?: string[];
  lastActive: number;
}

interface CursorPosition extends Record<string, Value> {
  x: number;
  y: number;
}
interface Collaborator extends PresenceEntry {}
type AppState = ExcalidrawAppState;

type SceneUpdateArgs = Parameters<ExcalidrawImperativeAPI["updateScene"]>[0];
type SceneElements = NonNullable<SceneUpdateArgs["elements"]>;
type SceneAppStateUpdate = NonNullable<SceneUpdateArgs["appState"]>;
type PresenceStoreState = Record<string, PresenceEntry>;
type EphemeralStoreInstance = EphemeralStore<PresenceStoreState>;

export function useLoroSync({
  roomId,
  userId,
  userName,
  userColor,
  wsUrl,
  excalidrawAPI,
}: UseLoroSyncOptions) {
  const docRef = useRef<LoroDoc | null>(null);
  const clientRef = useRef<LoroWebsocketClient | null>(null);
  const ephemeralRef = useRef<EphemeralStoreInstance | null>(null);
  const ephemeralAdaptorRef = useRef<LoroEphemeralAdaptor | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [collaborators, setCollaborators] = useState<Map<string, Collaborator>>(
    new Map()
  );
  const ignoreOnChangeRef = useRef(false);
  const lastChecksumRef = useRef<number>(-1);

  // Initialize Loro document and WebSocket client
  useEffect(() => {
    const doc = new LoroDoc();
    const client = new LoroWebsocketClient({ url: wsUrl });
    const ephAdaptor = new LoroEphemeralAdaptor(new EphemeralStore(30_000));
    const ephemeral = ephAdaptor.getStore() as EphemeralStoreInstance;

    docRef.current = doc;
    clientRef.current = client;
    ephemeralRef.current = ephemeral;
    ephemeralAdaptorRef.current = ephAdaptor;

    // Set up document structure
    const elementsContainer = doc.getList("elements");
    const appStateContainer = doc.getMap("appState");

    // Subscribe to document changes
    const unsubscribeDoc = doc.subscribe((event: LoroEventBatch) => {
      console.log(event);
      if (event.by !== "local") {
        // Build scene data from doc and apply to Excalidraw. Avoid echo via flag.
        // TODO: REVIEW [avoid echo] We set a guard so the next Excalidraw onChange from updateScene is ignored.
        const newElements = (elementsContainer.toJSON() || []) as SceneElements;
        const newAppState: Partial<AppState> = {};
        for (const [key, value] of appStateContainer.entries()) {
          newAppState[key as keyof AppState] = value;
        }
        ignoreOnChangeRef.current = true;
        // Update checksum to match scene state
        const checksum = newElements.reduce(
          (acc, e) => acc + (e?.version || 0),
          0
        );
        lastChecksumRef.current = checksum;
        const sceneUpdate: SceneUpdateArgs = { elements: newElements };
        if (Object.keys(newAppState).length > 0) {
          sceneUpdate.appState = newAppState as SceneAppStateUpdate;
        }
        excalidrawAPI.current?.updateScene(sceneUpdate);
      }
    });

    // Subscribe to ephemeral state changes (cursors, presence)
    // Subscribe to ephemeral state changes (cursors, presence) with throttle
    const THROTTLE_MS = 50;
    const recalcCollaborators = () => {
      const allStates = ephemeral.getAllStates();
      const newCollaborators = new Map<string, Collaborator>();
      for (const [key, value] of Object.entries(allStates)) {
        if (value && key !== userId) {
          newCollaborators.set(key, value as Collaborator);
        }
      }
      setCollaborators(newCollaborators);
    };
    const onEphemeralThrottled = throttle(THROTTLE_MS, recalcCollaborators);
    const unsubscribeEphemeral = ephemeral.subscribe(onEphemeralThrottled);
    recalcCollaborators();
    // Join rooms via loro-websocket client and adaptors
    const adaptor = new LoroAdaptor(doc);

    let rooms: { destroy: () => Promise<void> }[] = [];
    client
      .waitConnected()
      .then(async () => {
        setIsConnected(true);
        const docRoom = await client.join({ roomId, crdtAdaptor: adaptor });
        const ephRoom = await client.join({ roomId, crdtAdaptor: ephAdaptor });
        rooms = [docRoom, ephRoom];
      })
      .catch(err => {
        console.error("WebSocket connection failed:", err);
        setIsConnected(false);
      });

    // Cleanup
    return () => {
      unsubscribeDoc();
      unsubscribeEphemeral();
      onEphemeralThrottled.cancel();
      // Leave rooms and cleanup adaptors
      void Promise.allSettled(rooms.map(r => r.destroy())).finally(() => {
        setIsConnected(false);
      });
      // Adaptor destroy will also clean underlying stores/docs, but ensure store is destroyed
      try {
        ephemeralAdaptorRef.current?.destroy();
      } catch {}
    };
  }, [roomId, userId, wsUrl]);

  // Update cursor position
  const updateCursor = useCallback(
    (position: CursorPosition) => {
      if (!ephemeralRef.current) return;

      const currentState = (ephemeralRef.current.get(userId) ??
        {}) as PresenceEntry;
      const nextState: PresenceEntry = {
        ...currentState,
        userId,
        userName,
        userColor,
        cursor: position,
        lastActive: Date.now(),
      };
      ephemeralRef.current.set(userId, nextState);
    },
    [userId, userName, userColor]
  );

  // Update selected elements
  const updateSelection = useCallback(
    (selectedElementIds: string[]) => {
      if (!ephemeralRef.current) return;

      const currentState = (ephemeralRef.current.get(userId) ??
        {}) as PresenceEntry;
      const nextState: PresenceEntry = {
        ...currentState,
        userId,
        userName,
        userColor,
        selectedElementIds,
        lastActive: Date.now(),
      };
      ephemeralRef.current.set(userId, nextState);
    },
    [userId, userName, userColor]
  );

  // Record local Excalidraw changes into LoroDoc with minimal ops
  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], changedAppState?: AppState) => {
      if (!docRef.current) return;
      if (ignoreOnChangeRef.current) {
        // Skip echo from updateScene
        ignoreOnChangeRef.current = false;
        return;
      }

      // Fast path by aggregate element versions
      const checksum = elements.reduce((acc, e) => acc + (e?.version || 0), 0);
      if (checksum === lastChecksumRef.current) {
        if (changedAppState?.selectedElementIds) {
          const ids = Object.keys(changedAppState.selectedElementIds);
          updateSelection(ids);
        }
        return;
      }
      lastChecksumRef.current = checksum;

      const doc = docRef.current;
      const list = doc.getList("elements");
      const getMapAt = (index: number): LoroMap | undefined => {
        const value = list.get(index);
        return value instanceof LoroMap ? value : undefined;
      };
      const ensureMapAt = (index: number): LoroMap => {
        const map = getMapAt(index);
        if (!map) {
          throw new Error(`Expected LoroMap at index ${index}`);
        }
        return map;
      };

      // Filter out deleted
      const filtered = elements.filter(e => !e.isDeleted);

      // Build id->index map for the current list
      const buildIndex = () => {
        const idx = new Map<string, number>();
        for (let i = 0; i < list.length; i++) {
          const map = getMapAt(i);
          if (!map) continue;
          const id = map.get("id") as string | undefined;
          if (id) idx.set(id, i);
        }
        return idx;
      };

      let changed = false;
      let indexMap = buildIndex();

      for (let i = 0; i < filtered.length; i++) {
        const target = filtered[i];
        const id = target.id;
        const pos = indexMap.get(id);
        if (pos == null) {
          // New element: insert at the desired position
          list.insertContainer(i, new LoroMap());
          const map = ensureMapAt(i);
          for (const [k, v] of Object.entries(target)) {
            map.set(k, v);
          }
          changed = true;
          indexMap = buildIndex();
          continue;
        }

        if (pos !== i) {
          // Move element to the desired index
          list.delete(pos, 1);
          const adjI = pos < i ? i - 1 : i;
          list.insertContainer(adjI, new LoroMap());
          const map = ensureMapAt(adjI);
          for (const [k, v] of Object.entries(target)) {
            map.set(k, v);
          }
          changed = true;
          indexMap = buildIndex();
          continue;
        }

        // Same position: update only if version changed
        const map = ensureMapAt(i);
        const prevVersion = map.get("version");
        if (prevVersion !== target.version) {
          for (const [k, v] of Object.entries(target)) {
            map.set(k, v);
          }
          changed = true;
        }
      }

      // Remove trailing items beyond new length
      if (list.length > filtered.length) {
        list.delete(filtered.length, list.length - filtered.length);
        changed = true;
      }

      if (changed) {
        doc.commit();
      }

      // Update ephemeral selection if provided
      if (changedAppState?.selectedElementIds) {
        const ids = Object.keys(changedAppState.selectedElementIds);
        updateSelection(ids);
      }
    },
    [updateSelection]
  );

  return {
    isConnected,
    collaborators,
    onChange,
    updateCursor,
    updateSelection,
  };
}
