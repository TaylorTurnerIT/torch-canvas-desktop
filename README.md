# Torch Canvas Desktop

An offline Tauri 2 desktop port of **Torch Canvas by Jesse Roberts**.

Original site: <https://www.jessetnroberts.com/torch-canvas/>

The graph editor, symbolic shape inference, PyTorch code generator/importer, variance predictor, training exporter, and 21 bundled library entries come from Jesse Roberts's published page. This repository adds the desktop shell, native file access, offline packaging, and tests.

## Run

On macOS, open `src-tauri/target/release/bundle/macos/Torch Canvas.app` after building. The app bundles its own interface and logic; it does not load the original website or need a local server.

For development, install Node.js, Rust stable, and Apple's command line developer tools, then run:

```sh
npm ci
npm start
```

Build a macOS application bundle:

```sh
npm run build
```

The current configuration targets a macOS `.app` with an ad hoc signature for local use. Developer ID signing and notarization are not configured.

On Taylor's Mac, `~/Applications/Torch Canvas.app` links to this checkout's built bundle, and the Dock pins that link. Each `npm run build` updates the app behind the Dock entry. Quit and reopen the app to load a new build. Editing source files still requires rebuilding.

## Use

- Create models on the canvas or open one of the bundled examples through **Open / import**.
- Open `.py` or graph `.json` files through the native file picker. Open a project folder to browse its PyTorch models.
- Reopening the same native file selects its existing tab and preserves unsaved edits. File identity is retained across restarts; files with the same name in different folders remain separate.
- Press **Command+S** to save. Existing Python files retain code outside the imported model classes through the original source-merging logic.
- Use **Export SVG** for a diagram. Use **Export…** for model code, a training script, or a ZIP. Training export requires a connected loss and target; a model without a loss can still be saved with Command+S.
- The editor autosaves graph tabs and library edits in local WebView storage. Save important models to disk for a portable copy.

File access is granted by native file/folder selection and lasts for the current app process. Reopen files or folders after restarting. Saved tabs retain canonical file identity and the previous source baseline, but never filesystem permission. Reopening a file restores access to its existing tab. The adapter supports the File System Access API operations used by Torch Canvas; it is not a general implementation of that browser API. Python is exported as text; the desktop app does not execute models or install PyTorch.

## Source and attribution

`upstream/torch-canvas.html` is the unmodified page fetched on October 22, 2026. `upstream/source.json` records its URL, author, retrieval time, and SHA-256 digest. `scripts/prepare-web.py` derives `web/index.html` and applies desktop compatibility patches. The dimension evaluator uses an arithmetic parser instead of dynamic JavaScript compilation, so symbolic sizes and variance plots work under the desktop Content Security Policy. Unresolved or nonpositive prediction sizes produce a descriptive error. `web/desktop.js` adapts file operations to scoped Rust commands in `src-tauri/src/main.rs`.

The offline page uses system fonts instead of fetching Google Fonts. The desktop app and header use the user-supplied logo in `assets/logo.png`. Jesse Roberts is credited in the window title and editor header; the original page and icon remain preserved in the upstream snapshot.

The Content Security Policy explicitly permits style attributes used by the SVG plots and arrowheads. Script and style elements retain Tauri's nonce/hash protection. UI tests reproduce Tauri's generated nonce policy and check plot strokes, point colors, legends, and arrowheads in both light and dark mode.

No upstream license was identified in the retrieved page. This private port does not assert permission to relicense or redistribute Jesse Roberts's work. See [NOTICE](NOTICE).

## Validation

```sh
npm test
npx playwright install webkit
npm run test:ui
cargo test --release --manifest-path src-tauri/Cargo.toml
```

Source tests check snapshot integrity, generated Python syntax, import round trips, bundled example generation, variance prediction, and training generation. Dimension evaluation and variance are also tested with dynamic compilation disabled. WebKit tests use the desktop Content Security Policy and cover editing, reload persistence, native bridge saves, SVG/Python/ZIP export, folder export, cancellation, and variance with and without workers. The UI tests mock native dialogs and file commands. Rust tests check handle grants, path traversal, and symlink boundaries. Real native picker interaction is not covered by these tests.
