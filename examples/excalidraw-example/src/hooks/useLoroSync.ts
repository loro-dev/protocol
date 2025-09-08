import { useEffect, useRef, useCallback, useState } from "react";
import { throttle } from "throttle-debounce"; // TODO: REVIEW [stability] replace custom throttle with lib
import { LoroDoc, EphemeralStore, LoroEventBatch, LoroMap } from "loro-crdt";
import { LoroWebsocketClient } from "loro-websocket/client";
import { LoroAdaptor, LoroEphemeralAdaptor } from "loro-adaptors";
import { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";

interface UseLoroSyncOptions {
  roomId: string;
  userId: string;
  userName: string;
  userColor: string;
  wsUrl: string;
  excalidrawAPI: React.RefObject<ExcalidrawImperativeAPI>;
}

interface Collaborator {
  userId: string;
  userName: string;
  userColor: string;
  cursor?: { x: number; y: number };
  selectedElementIds?: string[];
  lastActive: number;
}

interface CursorPosition {
  x: number;
  y: number;
}

// Minimal type definitions for Excalidraw (to avoid import issues)
export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  [key: string]: any;
}

export interface AppState {
  [key: string]: any;
}

export function useLoroSync({
  roomId,
  userId,
  userName,
  userColor,
  wsUrl,
  excalidrawAPI
}: UseLoroSyncOptions) {
  const docRef = useRef<LoroDoc | null>(null);
  const clientRef = useRef<LoroWebsocketClient | null>(null);
  const ephemeralRef = useRef<EphemeralStore<Record<string, any>> | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [collaborators, setCollaborators] = useState<Map<string, Collaborator>>(new Map());
  const ignoreOnChangeRef = useRef(false);
  const lastChecksumRef = useRef<number>(-1);

  // Initialize Loro document and WebSocket client
  useEffect(() => {
    const doc = new LoroDoc();
    const client = new LoroWebsocketClient({ url: wsUrl });
    const ephemeral = new EphemeralStore<Record<string, any>>(30000); // 30 second timeout

    docRef.current = doc;
    clientRef.current = client;
    ephemeralRef.current = ephemeral;

    // Set up document structure
    const elementsContainer = doc.getList("elements");
    const appStateContainer = doc.getMap("appState");

    // Subscribe to document changes
    const unsubscribeDoc = doc.subscribe((event: LoroEventBatch) => {
      console.log(event);
      if (event.by !== "local") {
        // Build scene data from doc and apply to Excalidraw. Avoid echo via flag.
        // TODO: REVIEW [avoid echo] We set a guard so the next Excalidraw onChange from updateScene is ignored.
        const newElements = (elementsContainer.toJSON() || []) as ExcalidrawElement[];
        const newAppState: Partial<AppState> = {};
        for (const [key, value] of appStateContainer.entries()) {
          newAppState[key as keyof AppState] = value;
        }
        ignoreOnChangeRef.current = true;
        // Update checksum to match scene state
        const checksum = newElements.reduce((acc, e) => acc + (e?.version || 0), 0);
        lastChecksumRef.current = checksum;
        excalidrawAPI.current?.updateScene({ elements: newElements as any, appState: newAppState as any });
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
    const adaptor = new LoroAdaptor(doc, { peerId: userId });
    const ephAdaptor = new LoroEphemeralAdaptor(ephemeral, {});

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
        ephemeral.destroy();
      } catch { }
    };
  }, [roomId, userId, wsUrl]);

  // Update cursor position
  const updateCursor = useCallback((position: CursorPosition) => {
    if (!ephemeralRef.current) return;

    const currentState = ephemeralRef.current.get(userId) || {};
    ephemeralRef.current.set(userId, {
      ...currentState,
      userId,
      userName,
      userColor,
      cursor: position,
      lastActive: Date.now(),
    });
  }, [userId, userName, userColor]);

  // Update selected elements
  const updateSelection = useCallback((selectedElementIds: string[]) => {
    if (!ephemeralRef.current) return;

    const currentState = ephemeralRef.current.get(userId) || {};
    ephemeralRef.current.set(userId, {
      ...currentState,
      userId,
      userName,
      userColor,
      selectedElementIds,
      lastActive: Date.now(),
    });
  }, [userId, userName, userColor]);

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

      // Filter out deleted
      const filtered = elements.filter(e => !e.isDeleted);

      // Build id->index map for the current list
      const buildIndex = () => {
        const idx = new Map<string, number>();
        for (let i = 0; i < list.length; i++) {
          const m = list.get(i) as unknown as LoroMap | undefined;
          if (!m) continue;
          const id = m.get("id") as string | undefined;
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
          const m = list.get(i) as unknown as LoroMap;
          for (const [k, v] of Object.entries(target)) {
            m.set(k, v);
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
          const m = list.get(adjI) as unknown as LoroMap;
          for (const [k, v] of Object.entries(target)) {
            m.set(k, v);
          }
          changed = true;
          indexMap = buildIndex();
          continue;
        }

        // Same position: update only if version changed
        const m = list.get(i) as unknown as LoroMap;
        const prevVersion = m.get("version");
        if (prevVersion !== target.version) {
          for (const [k, v] of Object.entries(target)) {
            m.set(k, v);
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
