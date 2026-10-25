# Torch Canvas Desktop

An offline Tauri 2 desktop port of **Torch Canvas by Jesse Roberts**.

Original site: <https://www.jessetnroberts.com/torch-canvas/>

The graph editor, symbolic shape inference, PyTorch code generator/importer, variance predictor, training exporter, and 21 bundled library entries come from Jesse Roberts's published page. This repository adds the desktop shell, native file access, offline packaging, and tests.

## Run

On macOS, open `src-tauri/target/release/bundle/macos/Torch Canvas.app` after building. The app bundles its own interface and logic; it does not load the original website or need a local server.

For development, install Node.js, Rust stable, and Apple's command line developer tools, then run:

```sh
npm ci
npm run desktop:dev
```

Build a macOS application bundle:

```sh
npm run desktop:build
```

The current configuration targets a macOS `.app` with an ad hoc signature for local use. Developer ID signing and notarization are not configured.

## Use

- Create models on the canvas or open one of the bundled examples through **Open / import**.
- Open `.py` or graph `.json` files through the native file picker. Open a project folder to browse its PyTorch models.
- Reopening the same native file selects its existing tab and preserves unsaved edits. File identity is retained across restarts; files with the same name in different folders remain separate.
- Press **Command+S** to save. Existing Python files retain code outside the imported model classes through the original source-merging logic.
- Incomplete output paths block Python saves until reconnected. A completed diagram can also repair an older block saved with `return None`.
- Use **Export SVG** for a diagram. Use **Export…** for model code, a training script, or a ZIP. Training export requires a connected loss and target; a model without a loss can still be saved with Command+S.
- The editor autosaves graph tabs and library edits in local WebView storage. Save important models to disk for a portable copy.

- **Code panel** is an editor. Typing updates the diagram after a short pause; a syntax error is reported and the diagram keeps its last good version. When a `.py` file is open, the panel shows that file's real text. Diagram edits patch only the constructor statements and methods they change, so comments, docstrings, extra methods, and training code stay as written. Adding or rewiring layers rewrites `forward`, keeping its signature and docstring but not its comments. Renaming the model renames its class. Names that other code uses are not updated. **Auto-save** writes the file after each edit.
- **marimo notebooks** open like any `.py` file. Model classes must be top-level `@app.class_definition` cells, which marimo writes for pure classes. New classes keep that decorator and missing imports go in the `with app.setup:` block. Saves are atomic, so a running `marimo edit --watch` reloads cleanly. Torch Canvas follows marimo's edits when the editor has no unsaved changes. The desktop app watches the open file and reacts at once; the browser version checks it on focus and every 5 seconds; otherwise the file bar shows **changed on disk**, and saving replaces the file with your version.

- **marimo pane**: with a marimo notebook open, the **marimo** tab beside **PyTorch** starts `marimo edit --headless --watch` for it and embeds the page. It uses `uv run` in the notebook's nearest `pyproject.toml` project (`--locked` when `uv.lock` exists), or `marimo` on your PATH otherwise. The first start can take a while. The server listens only on `127.0.0.1` on a random port without an access token, and stops with **Stop** or when the app quits. Turn on **auto-save** to have diagram and code edits reach marimo as you make them. Drag the dividers beside the palette and the right pane to resize them; double-click a divider to reset it, or focus it and use the arrow keys. Sizes persist.

- **Open / import** lists up to five recently opened examples and files at the top, newest first, and hides the list when there are none. Choosing a recent file reopens it, or switches to its tab if one is open. The native side keeps a list of paths you picked in the file dialog or opened from Finder (`recent-files.json` in the app data folder) and reopens only those. A file you have not picked since this feature existed, or one that moved, asks you to choose it again once.

File access is granted by native file/folder selection and lasts for the current app process, apart from the remembered recent-file paths described above. Reopen files or folders after restarting. Saved tabs retain canonical file identity and the previous source baseline, but never filesystem permission. Reopening a file restores access to its existing tab. The adapter supports the File System Access API operations used by Torch Canvas; it is not a general implementation of that browser API. Python is exported as text; the desktop app does not execute models or install PyTorch.

## Source and attribution

`upstream/source.json` records the upstream repository URL, author, and license. `scripts/prepare-web.py` runs `node build.js` to build `index.html` from the upstream sources, then derives `web/index.html` and applies desktop compatibility patches. The dimension evaluator uses an arithmetic parser instead of dynamic JavaScript compilation, so symbolic sizes and variance plots work under the desktop Content Security Policy. Unresolved or nonpositive prediction sizes produce a descriptive error. `web/desktop.js` adapts file operations to scoped Rust commands in `src-tauri/src/main.rs`.

The offline page uses system fonts instead of fetching Google Fonts. The author's original icon is preserved, and Jesse Roberts is credited in the window title and editor header.

The Content Security Policy explicitly permits style attributes used by the SVG plots and arrowheads. Script and style elements retain Tauri's nonce/hash protection. UI tests reproduce Tauri's generated nonce policy and check plot strokes, point colors, legends, and arrowheads in both light and dark mode.

This repository is a fork of [JesseTNRoberts/torch-canvas](https://github.com/JesseTNRoberts/torch-canvas), which is MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The upstream files (`index.html`, `core.js`, `examples/` and the rest at the repository root) are the original web app; the desktop port lives in `web/`, `src-tauri/`, `scripts/`, and `tests/`.

## Validation

```sh
npm test
npm run desktop:test
npx playwright install webkit
npm run desktop:test:ui
cargo test --release --manifest-path src-tauri/Cargo.toml
```

Source tests check upstream provenance, generated Python syntax, import round trips, bundled example generation, variance prediction, and training generation. Dimension evaluation and variance are also tested with dynamic compilation disabled. WebKit tests use the desktop Content Security Policy and cover editing, reload persistence, native bridge saves, SVG/Python/ZIP export, folder export, cancellation, and variance with and without workers. The UI tests mock native dialogs and file commands. Rust tests check handle grants, path traversal, and symlink boundaries. Real native picker interaction is not covered by these tests.

## Desktop app (Tauri)

Requirements: Node.js, Rust stable, and Apple's command line developer tools. `uv` or `marimo` on your PATH is needed only for the marimo tab.

```sh
npm ci
npm run desktop:dev        # run the desktop app in development
npm run desktop:build      # build src-tauri/target/release/bundle/macos/Torch Canvas.app
```

The built app is signed ad hoc and is not notarized.

Tests:

```sh
npm run desktop:prepare    # run build.js, then regenerate web/index.html from it
npm run desktop:test       # source and logic tests (node --test)
npx playwright install webkit   # once
npm run desktop:test:ui    # WebKit tests with a mocked native bridge
npm run desktop:test:native     # Rust tests
```

The native test that starts a real marimo server is ignored by default. Run it with a notebook path, for example `tests/fixtures/marimo-net.py`:

```sh
MARIMO_TEST_FILE=tests/fixtures/marimo-net.py cargo test --manifest-path src-tauri/Cargo.toml -- --ignored marimo_runs_and_stops
```

Recent files and examples appear at the top of **Open / import**, newest first, up to five. Choosing one reopens it or switches to its open tab. The app remembers paths you picked in the file dialog or opened from Finder, in `recent-files.json` in the app data folder. A file that has moved, or one picked before this list existed, asks you to choose it again.

Opening a `.py` file from Finder (or `open -a`) loads it into the editor. The app also registers `.py` as a file type it can open.

Resize the palette and the right pane by dragging their dividers. Double-click a divider to reset it, or focus it and press the left or right arrow keys. Sizes persist between launches.

## Editing in marimo

Open a marimo notebook (a `.py` file with `import marimo` and `marimo.App(...)`) and the **marimo** tab appears beside **PyTorch**. Choosing the tab starts `marimo edit --headless --watch` for that file and embeds the page:

- The server runs locally, on a random port on `127.0.0.1`, without an access token. It stops when you press **Stop** or quit the app.
- If the notebook is inside a project with a `pyproject.toml`, the server runs with `uv run` in that project (adding `--locked` when `uv.lock` exists). Otherwise it uses `marimo` from your PATH. The first start can take a while while `uv` prepares the environment.
- **Reload** reloads the embedded page.
- **auto-save** writes the file shortly after each diagram or code edit, so the running notebook follows your changes. It is on by default; untick it to save by hand. Your choice is remembered.

The **PyTorch** code panel is an editor for the open file. Model classes must be top-level `@app.class_definition` cells, and new classes keep that decorator. Imports for regenerated classes go in the `with app.setup:` block. Saving keeps code you did not change and patches only the constructor statements, signature defaults, and methods that the diagram changed. Comments inside a rewritten `forward` body are lost. Renaming the model renames only its class.

Limits:

- Only top-level classes are recognized. Classes nested inside an `@app.cell` are not model classes.
- The app watches only the active tab. When the file changes on disk and you have no unsaved edits, the diagram updates. With unsaved edits, the file bar shows **changed on disk**.
- There is no three-way merge. Saving after a disk change asks for confirmation, then replaces the disk version with the editor text.

The web build (`npm start` and the copy on the original author's site) has no marimo tab, because it has no local process to run.
