// File System Access API adapter for Tauri's native dialogs and scoped file handles.
// Torch Canvas's existing import, merge, save, project scan, and export flows use it.
(() => {
  if (!window.__TAURI__) return;
  const invoke = window.__TAURI__.core.invoke;

  function handle(info) {
    const result = {
      name: info.name,
      kind: info.kind,
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return !!info.identity && other?._nativeIdentity === info.identity; },
      _nativeId: info.id,
      _nativeIdentity: info.identity,
    };
    if (info.kind === 'file') {
      result.getFile = async () => {
        const data = await invoke('native_read', { id: info.id });
        return new File([new Uint8Array(data.bytes)], info.name, { lastModified: data.lastModified });
      };
      result.createWritable = async () => {
        let bytes = new Uint8Array();
        let closed = false;
        return {
          async write(data) {
            if (closed) throw new Error('Writer is closed');
            const blob = data instanceof Blob ? data : new Blob([data]);
            bytes = new Uint8Array(await blob.arrayBuffer());
          },
          async close() {
            if (closed) throw new Error('Writer is closed');
            await invoke('native_write', { id: info.id, bytes: Array.from(bytes) });
            closed = true;
          },
          async abort() { closed = true; },
        };
      };
    } else {
      result.entries = async function* () {
        for (const entry of await invoke('native_entries', { id: info.id })) yield [entry.name, handle(entry)];
      };
      result.getFileHandle = async (name, options = {}) => handle(await invoke('native_child', { id: info.id, name, create: !!options.create }));
    }
    return result;
  }

  async function pick(mode, name = null) {
    const result = await invoke('native_pick', { mode, name });
    if (!result) throw new DOMException('File selection cancelled', 'AbortError');
    return handle(result);
  }
  window.showOpenFilePicker = async () => [await pick('open')];
  window.showSaveFilePicker = async (options = {}) => pick('save', options.suggestedName);
  window.showDirectoryPicker = async () => pick('directory');
  window.torchDesktop = {
    async save(name, data) {
      try {
        const file = await pick('save', name);
        const writer = await file.createWritable();
        await writer.write(data);
        await writer.close();
        return true;
      } catch (error) {
        if (error.name === 'AbortError') return false;
        throw error;
      }
    },
  };
})();
