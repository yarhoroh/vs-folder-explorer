import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { LocalFsProvider, LOCAL_SCHEME } from './localFsProvider';

/**
 * Webview-based explorer: a file tree on the left and a vertical, scrollable
 * strip of bookmark chips on the right. Clicking a chip switches the directory
 * shown in the tree. One directory at a time; "Up" navigates without changing
 * the saved bookmark.
 */
export class ExplorerViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private currentRoot: vscode.Uri | undefined;
  private activeKey: string | undefined;
  private seti: any;
  private clipboard: string[] = [];
  private bufferCts: vscode.CancellationTokenSource | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedKey: string | undefined;
  private pendingDirs = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly extensionUri: vscode.Uri,
  ) {
    const proj = this.projectFolders();
    this.activeKey = (proj[0] ?? this.getBookmarks()[0])?.toString();
    this.currentRoot = this.activeKey ? vscode.Uri.parse(this.activeKey) : undefined;
  }

  // ---- bookmarks (global) ----------------------------------------------

  /** Stable key for the current project (first workspace folder) so bookmarks don't mix across projects. */
  private projectKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '_noproject';
  }

  private getBookmarks(): vscode.Uri[] {
    const all = this.globalState.get<Record<string, string[]>>('vsfe.bookmarksByProject', {});
    return (all[this.projectKey()] ?? []).map(safeParse).filter((u): u is vscode.Uri => !!u);
  }

  private async saveBookmarks(uris: vscode.Uri[]): Promise<void> {
    const all = this.globalState.get<Record<string, string[]>>('vsfe.bookmarksByProject', {});
    all[this.projectKey()] = dedupe(uris).map((u) => u.toString());
    await this.globalState.update('vsfe.bookmarksByProject', all);
  }

  /** Whether a bookmark can still be read from this window — hides dead/foreign folders. */
  private async reachable(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** Workspace folders — shown as permanent, non-removable "home" bookmarks. */
  private projectFolders(): vscode.Uri[] {
    return vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [];
  }

  private containingProject(uri: vscode.Uri): vscode.Uri | undefined {
    return this.projectFolders().find((w) => {
      if (uri.scheme !== w.scheme || uri.authority !== w.authority) {
        return false;
      }
      const base = w.path.endsWith('/') ? w.path : w.path + '/';
      return uri.path === w.path || uri.path.startsWith(base);
    });
  }

  private isInProject(uri: vscode.Uri): boolean {
    return !!this.containingProject(uri);
  }

  // ---- WebviewViewProvider ---------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => {
      this.watcher?.dispose();
      this.watcher = undefined;
      this.watchedKey = undefined;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
    });
  }

  // ---- live folder watching --------------------------------------------

  /** (Re)attach a recursive watcher to the folder currently shown, so new/deleted files auto-refresh. */
  private refreshWatch(): void {
    const key = this.currentRoot?.toString();
    if (key === this.watchedKey) {
      return;
    }
    this.watchedKey = key;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.pendingDirs.clear();
    if (!this.currentRoot) {
      return;
    }
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.currentRoot, '**'));
      const onEvt = (uri: vscode.Uri) => this.scheduleRefresh(uri.with({ path: path.posix.dirname(uri.path) }));
      w.onDidCreate(onEvt);
      w.onDidDelete(onEvt);
      w.onDidChange(onEvt);
      this.watcher = w;
    } catch {
      /* some schemes can't be watched — silently skip */
    }
  }

  /** Debounce a batch of changed directories, then re-send their listings to the webview. */
  private scheduleRefresh(dir: vscode.Uri): void {
    this.pendingDirs.add(dir.toString());
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const dirs = [...this.pendingDirs];
      this.pendingDirs.clear();
      for (const d of dirs) {
        void this.sendChildren(d);
      }
    }, 300);
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.postInit();
        break;
      case 'switch':
        this.activeKey = msg.uri;
        this.currentRoot = safeParse(msg.uri);
        this.postInit();
        break;
      case 'up':
        if (this.currentRoot) {
          const parent = path.posix.dirname(this.currentRoot.path);
          if (parent !== this.currentRoot.path) {
            this.currentRoot = this.currentRoot.with({ path: parent });
            this.postRoot();
          }
        }
        break;
      case 'refresh':
        this.postRoot();
        break;
      case 'open':
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
        break;
      case 'children':
        await this.sendChildren(msg.uri);
        break;
      case 'search':
        await this.doSearch(msg.query);
        break;
      case 'add':
        await this.cmdAddBookmark();
        break;
      case 'remove':
        await this.removeBookmark(msg.uri);
        break;
      case 'bookmarkAdd':
        await this.addBookmarkUri(msg.uri);
        break;
      case 'copy':
        this.clipboard = msg.uris ?? (msg.uri ? [msg.uri] : []);
        void this.bufferToClipboard(this.clipboard);
        break;
      case 'paste':
        await this.paste(msg.uri);
        break;
      case 'newFolder':
        await this.newFolder(msg.uri);
        break;
      case 'dropTransfer':
        await this.dropTransfer(msg.src, msg.dest);
        break;
      case 'delete':
        await this.deleteEntries(msg.uris ?? (msg.uri ? [msg.uri] : []));
        break;
      case 'rename':
        await this.renameEntry(msg.uri, msg.newName);
        break;
      case 'reveal':
        await this.reveal(msg.uri);
        break;
      case 'copyPath':
        await this.copyPath(msg.uri);
        break;
      case 'copyRelativePath':
        await this.copyRelativePath(msg.uri);
        break;
      case 'preview':
        await this.sendPreview(msg.uri);
        break;
      case 'info':
        await this.sendInfo(msg.uri);
        break;
    }
  }

  private async copyPath(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    const text = uri.scheme === 'file' ? uri.fsPath : uri.scheme === LOCAL_SCHEME ? toLocalPath(uri) : uri.path;
    await vscode.env.clipboard.writeText(text);
  }

  private async copyRelativePath(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    const wf = this.containingProject(uri);
    const rel = wf ? uri.path.slice(wf.path.length).replace(/^\//, '') : uri.path;
    await vscode.env.clipboard.writeText(rel);
  }

  /** Read an image and send it back as a data URI for the hover preview. */
  private async sendPreview(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > 5_000_000) {
        return;
      }
      const data = await vscode.workspace.fs.readFile(uri);
      const b64 = Buffer.from(data).toString('base64');
      const mime = sniffMime(data, path.posix.basename(uri.path));
      this.post({ type: 'preview', uri: uriStr, dataUri: `data:${mime};base64,${b64}` });
    } catch {
      /* ignore */
    }
  }

  /** Hover info: exact size for a file; recursive item counts + total size for a folder
   * (budgeted to a few seconds so a huge tree over SSH returns a partial answer instead of hanging). */
  private async sendInfo(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    let st: vscode.FileStat;
    try {
      st = await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }
    if ((st.type & vscode.FileType.Directory) === 0) {
      this.post({ type: 'info', uri: uriStr, info: { kind: 'file', size: st.size, mtime: st.mtime } });
      return;
    }
    const s = await this.folderStats(uri);
    this.post({ type: 'info', uri: uriStr, info: { kind: 'dir', mtime: st.mtime, ...s } });
  }

  private async folderStats(
    root: vscode.Uri,
  ): Promise<{ items: number; files: number; dirs: number; bytes: number; truncated: boolean }> {
    const deadline = Date.now() + 4000;
    let items = 0;
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let truncated = false;
    let first = true;
    const queue: vscode.Uri[] = [root];
    while (queue.length) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const dir = queue.shift()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        continue;
      }
      if (first) {
        items = entries.length; // immediate children of the hovered folder
        first = false;
      }
      for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(dir, name);
        const isDir = (type & vscode.FileType.Directory) !== 0;
        if (isDir) {
          dirs++;
          if ((type & vscode.FileType.SymbolicLink) === 0) {
            queue.push(child); // don't follow symlinks (cycles)
          }
        } else {
          files++;
          try {
            bytes += (await vscode.workspace.fs.stat(child)).size;
          } catch {
            /* unreadable — skip its size */
          }
        }
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
      }
      if (truncated) {
        break;
      }
    }
    return { items, files, dirs, bytes, truncated };
  }

  /** Rename a file/folder in place (F2 / context menu). Refreshes the parent so the new name & order show. */
  private async renameEntry(uriStr: string, newName: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri || !newName) {
      return;
    }
    const clean = newName.replace(/[\\/]/g, '').trim();
    const parent = uri.with({ path: path.posix.dirname(uri.path) });
    if (!clean || clean === path.posix.basename(uri.path)) {
      return;
    }
    const dest = uri.with({ path: path.posix.join(path.posix.dirname(uri.path), clean) });
    if (await this.reachable(dest)) {
      vscode.window.showErrorMessage(`"${clean}" already exists.`);
      await this.sendChildren(parent.toString());
      return;
    }
    try {
      await vscode.workspace.fs.rename(uri, dest, { overwrite: false });
    } catch (e) {
      vscode.window.showErrorMessage(`Rename failed: ${e}`);
    }
    await this.sendChildren(parent.toString());
  }

  /** Create a new directory inside the given folder (or the current root). */
  private async newFolder(parentStr: string): Promise<void> {
    const parent = safeParse(parentStr);
    if (!parent) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'New folder name', value: 'New Folder' });
    if (!name) {
      return;
    }
    const clean = name.replace(/[\\/]/g, '').trim();
    if (!clean) {
      return;
    }
    const dir = vscode.Uri.joinPath(parent, clean);
    if (await this.reachable(dir)) {
      vscode.window.showErrorMessage(`"${clean}" already exists.`);
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch (e) {
      vscode.window.showErrorMessage(`Create folder failed: ${e}`);
      return;
    }
    await this.sendChildren(parent.toString());
  }

  /** Delete one or more files/folders on any scheme (local, SSH, workspace). */
  private async deleteEntries(uriStrs: string[]): Promise<void> {
    const uris = uriStrs.map(safeParse).filter((u): u is vscode.Uri => !!u);
    if (!uris.length) {
      return;
    }
    const label = uris.length === 1 ? `"${path.posix.basename(uris[0].path)}"` : `${uris.length} items`;
    const ok = await vscode.window.showWarningMessage(
      `Delete ${label}? This cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (ok !== 'Delete') {
      return;
    }
    const parents = new Set<string>();
    for (const uri of uris) {
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true });
        } catch (e) {
          vscode.window.showErrorMessage(`Delete failed: ${e}`);
          continue;
        }
      }
      parents.add(uri.with({ path: path.posix.dirname(uri.path) }).toString());
    }
    for (const p of parents) {
      await this.sendChildren(p);
    }
  }

  /** Open the local Windows File Explorer at the file's location (local files only). */
  private async reveal(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    if (uri.scheme !== LOCAL_SCHEME && uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Reveal in File Explorer works only for local files.');
      return;
    }
    const p = uri.scheme === 'file' ? uri.fsPath : toLocalPath(uri);
    const win = p.replace(/\//g, '\\');
    cp.exec(`explorer.exe /select,"${win}"`, () => undefined);
  }

  /** Buffer the selected items onto the Windows clipboard as files (CF_HDROP). Remote items are
   * downloaded to a local temp folder first. A new call cancels any in-progress buffering. */
  private async bufferToClipboard(uriStrs: string[]): Promise<void> {
    this.bufferCts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.bufferCts = cts;
    const localPaths: string[] = [];
    try {
      for (const s of uriStrs) {
        if (cts.token.isCancellationRequested) {
          return;
        }
        const uri = safeParse(s);
        if (!uri) {
          continue;
        }
        if (uri.scheme === 'file') {
          localPaths.push(uri.fsPath);
        } else if (uri.scheme === LOCAL_SCHEME) {
          localPaths.push(toLocalPath(uri).replace(/\//g, '\\'));
        } else {
          // Remote (SSH/workspace): download to a local temp file so Windows Explorer can paste it.
          const name = path.posix.basename(uri.path);
          const tmpDir = LocalFsProvider.toUri(path.join(os.tmpdir(), 'vsfe-clip'));
          await vscode.workspace.fs.createDirectory(tmpDir);
          const destLocal = vscode.Uri.joinPath(tmpDir, name);
          try {
            await vscode.workspace.fs.delete(destLocal, { recursive: true });
          } catch {
            /* nothing to clear */
          }
          await this.copyTree(uri, destLocal, `Buffering "${name}"…`, cts.token);
          localPaths.push(toLocalPath(destLocal).replace(/\//g, '\\'));
        }
      }
    } catch {
      return; // canceled or failed
    }
    if (cts !== this.bufferCts || cts.token.isCancellationRequested) {
      return; // superseded by a newer copy
    }
    if (localPaths.length) {
      const list = localPaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
      cp.exec(`powershell -NoProfile -Command "Set-Clipboard -LiteralPath ${list}"`, () => {
        vscode.window.setStatusBarMessage(`$(clippy) ${localPaths.length} item(s) ready to paste`, 4000);
      });
    } else {
      cp.exec(`powershell -NoProfile -Command "Set-Clipboard -Value ' '"`, () => undefined);
    }
  }

  /** Read the file list currently on the Windows clipboard (empty if it holds text/nothing). */
  private osClipboardGetFiles(): Promise<string[]> {
    return new Promise((resolve) => {
      cp.exec(
        'powershell -NoProfile -Command "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"',
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
        },
      );
    });
  }

  /** Paste into a target folder. Prefers files on the Windows clipboard (copy in Windows Explorer →
   * paste here, even onto SSH), then falls back to the in-panel clipboard (SSH ↔ SSH ↔ local). */
  private async paste(targetStr: string): Promise<void> {
    const destDir = safeParse(targetStr);
    if (!destDir) {
      return;
    }
    const osFiles = await this.osClipboardGetFiles();
    const srcs = osFiles.length
      ? osFiles.map((p) => LocalFsProvider.toUri(p)) // read local disk via our provider (works even over SSH)
      : this.clipboard.map(safeParse).filter((u): u is vscode.Uri => !!u);
    if (!srcs.length) {
      vscode.window.showInformationMessage('Clipboard is empty — Copy a file first.');
      return;
    }
    let failed = 0;
    for (const src of srcs) {
      try {
        const dest = await this.uniqueDest(destDir, path.posix.basename(src.path));
        await this.copyTree(src, dest, `Copying "${path.posix.basename(src.path)}"…`);
      } catch {
        failed++;
      }
    }
    if (failed) {
      vscode.window.showErrorMessage(`Paste failed for ${failed} item(s).`);
    }
    await this.sendChildren(destDir.toString());
  }

  /** Drag-and-drop within the tree: on drop, ask Move / Copy / Cancel, then act. */
  private async dropTransfer(srcStr: string, destStr: string): Promise<void> {
    const src = safeParse(srcStr);
    const destDir = safeParse(destStr);
    if (!src || !destDir) {
      return;
    }
    const sameFs = src.scheme === destDir.scheme && src.authority === destDir.authority;
    // Don't drop a folder into itself or into its own subtree.
    if (sameFs && (destDir.path === src.path || destDir.path.startsWith(src.path.replace(/\/?$/, '/')))) {
      return;
    }
    const name = path.posix.basename(src.path);
    const destName = path.posix.basename(destDir.path) || destDir.path;
    const choice = await vscode.window.showInformationMessage(
      `"${name}" → "${destName}"`,
      { modal: true },
      'Move',
      'Copy',
    );
    if (choice !== 'Move' && choice !== 'Copy') {
      return; // Cancel / Esc
    }
    const move = choice === 'Move';
    const srcParent = src.with({ path: path.posix.dirname(src.path) });
    // Moving into the folder it already lives in is a no-op.
    if (move && sameFs && destDir.path === srcParent.path) {
      return;
    }
    const dest = await this.uniqueDest(destDir, path.posix.basename(src.path));
    try {
      if (move && sameFs) {
        await vscode.workspace.fs.rename(src, dest, { overwrite: false });
      } else if (move) {
        await this.copyTree(src, dest, `Moving "${name}"…`);
        await vscode.workspace.fs.delete(src, { recursive: true });
      } else {
        await this.copyTree(src, dest, `Copying "${name}"…`);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`${move ? 'Move' : 'Copy'} failed: ${e}`);
      return;
    }
    await this.sendChildren(destDir.toString());
    if (move) {
      await this.sendChildren(srcParent.toString());
    }
  }

  private async copyRecursive(
    src: vscode.Uri,
    dest: vscode.Uri,
    onFile?: () => void,
    check?: () => boolean,
  ): Promise<void> {
    if (check && check()) {
      throw new Error('Canceled');
    }
    const st = await vscode.workspace.fs.stat(src);
    if ((st.type & vscode.FileType.Directory) !== 0) {
      await vscode.workspace.fs.createDirectory(dest);
      for (const [name] of await vscode.workspace.fs.readDirectory(src)) {
        await this.copyRecursive(vscode.Uri.joinPath(src, name), vscode.Uri.joinPath(dest, name), onFile, check);
      }
    } else {
      const data = await vscode.workspace.fs.readFile(src);
      await vscode.workspace.fs.writeFile(dest, data);
      onFile?.();
    }
  }

  /** Copy a tree with a standard bottom-right progress notification (file-count, since byte-level isn't exposed). */
  private async copyTree(
    src: vscode.Uri,
    dest: vscode.Uri,
    title: string,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: !!token },
      async (progress, progToken) => {
        let n = 0;
        const check = () => (!!token && token.isCancellationRequested) || progToken.isCancellationRequested;
        await this.copyRecursive(src, dest, () => {
          n++;
          progress.report({ message: `${n} file(s)` });
        }, check);
      },
    );
  }

  private async uniqueDest(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
    let cand = vscode.Uri.joinPath(dir, name);
    if (!(await this.reachable(cand))) {
      return cand;
    }
    const ext = path.posix.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let i = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      cand = vscode.Uri.joinPath(dir, `${base} copy${i > 1 ? ' ' + i : ''}${ext}`);
      if (!(await this.reachable(cand))) {
        return cand;
      }
      i++;
    }
  }

  /** Build the chip list: project folders (🏠, permanent) + reachable user bookmarks. */
  private async buildBookmarks(): Promise<{ uri: string; name: string; kind: string }[]> {
    const proj = this.projectFolders();
    const projKeys = new Set(proj.map((u) => u.toString()));
    const users = this.getBookmarks().filter((u) => !projKeys.has(u.toString()));
    const reach = await Promise.all(users.map((u) => this.reachable(u)));
    const visible = users.filter((_, i) => reach[i]);
    return [
      ...proj.map((u) => ({ uri: u.toString(), name: baseName(u), kind: 'project' })),
      ...visible.map((u) => ({ uri: u.toString(), name: baseName(u), kind: 'user' })),
    ];
  }

  private async postInit(): Promise<void> {
    this.post({
      type: 'init',
      bookmarks: await this.buildBookmarks(),
      active: this.activeKey,
      root: this.currentRoot?.toString(),
      rootLabel: this.currentRoot ? displayPath(this.currentRoot) : '',
    });
    this.refreshWatch();
  }

  /** Refresh only the bookmark strip, without rebuilding the tree (keeps expansion). */
  private async postBookmarks(): Promise<void> {
    this.post({ type: 'bookmarks', bookmarks: await this.buildBookmarks(), active: this.activeKey });
  }

  /** Add a specific folder as a bookmark (folder right-click → Add Bookmark). */
  private async addBookmarkUri(uriStr: string): Promise<void> {
    const uri = safeParse(uriStr);
    if (!uri) {
      return;
    }
    const name = path.posix.basename(uri.path) || uri.path;
    const projKeys = new Set(this.projectFolders().map((u) => u.toString()));
    if (projKeys.has(uri.toString())) {
      vscode.window.setStatusBarMessage('$(home) Already the project (home) bookmark', 3000);
      return;
    }
    if (this.getBookmarks().some((u) => u.toString() === uri.toString())) {
      vscode.window.setStatusBarMessage(`$(bookmark) Already bookmarked: ${name}`, 3000);
    } else {
      await this.saveBookmarks([...this.getBookmarks(), uri]);
      vscode.window.setStatusBarMessage(`$(bookmark) Bookmarked: ${name}`, 3000);
    }
    await this.postBookmarks();
  }

  /** Bookmark the selected folder (or the current root if nothing is selected). The
   * webview owns the selection, so ask it which folder to bookmark. */
  async cmdBookmarkCurrent(): Promise<void> {
    if (this.view) {
      this.post({ type: 'requestBookmark' });
      return;
    }
    if (this.currentRoot) {
      await this.addBookmarkUri(this.currentRoot.toString());
    }
  }

  private postRoot(): void {
    this.post({
      type: 'root',
      root: this.currentRoot?.toString(),
      rootLabel: this.currentRoot ? displayPath(this.currentRoot) : '',
    });
    this.refreshWatch();
  }

  private async sendChildren(uriStr: string): Promise<void> {
    const dir = safeParse(uriStr);
    if (!dir) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return; // transient read failure — don't clobber the folder with an empty list
    }
    entries.sort(compareEntries);
    await this.loadSeti();
    const items = entries.map(([name, type]) => {
      const child = vscode.Uri.joinPath(dir, name);
      const isDir = (type & vscode.FileType.Directory) !== 0;
      return {
        uri: child.toString(),
        name,
        dir: isDir,
        icon: isDir ? undefined : this.iconFor(name),
        inProject: this.isInProject(child),
        dragUri: child.scheme === LOCAL_SCHEME ? vscode.Uri.file(toLocalPath(child)).toString() : child.toString(),
      };
    });
    this.post({ type: 'children', uri: uriStr, items });
  }

  /** Loads the bundled Seti file-icon theme (font glyph map) once. */
  private async loadSeti(): Promise<void> {
    if (this.seti) {
      return;
    }
    try {
      const uri = vscode.Uri.joinPath(this.extensionUri, 'media', 'seti.json');
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.seti = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      this.seti = { iconDefinitions: {}, fileExtensions: {}, fileNames: {}, languageIds: {}, file: '_default' };
    }
  }

  /** Resolves a file name to its Seti icon (glyph char + color), like the stock Explorer. */
  private iconFor(name: string): { ch: string; color?: string } | undefined {
    const s = this.seti;
    if (!s) {
      return undefined;
    }
    const lower = name.toLowerCase();
    let id: string | undefined = s.fileNames[lower];
    if (!id) {
      const parts = lower.split('.');
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join('.');
        if (s.fileExtensions[suffix]) {
          id = s.fileExtensions[suffix];
          break;
        }
      }
    }
    if (!id) {
      const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
      const lang = EXT2LANG[ext];
      if (lang && s.languageIds[lang]) {
        id = s.languageIds[lang];
      }
    }
    const key: string = (id ?? s.file ?? '_default') as string;
    const def = s.iconDefinitions[key] ?? s.iconDefinitions[s.file];
    if (!def) {
      return undefined;
    }
    return { ch: setiChar(def.fontCharacter), color: def.fontColor };
  }

  // ---- commands (also invoked from the view title) ---------------------

  async cmdAddBookmark(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add Bookmark',
    });
    if (!picked?.length) {
      return;
    }
    await this.saveBookmarks([...this.getBookmarks(), ...picked]);
    this.activeKey = picked[picked.length - 1].toString();
    this.currentRoot = picked[picked.length - 1];
    this.postInit();
  }

  /** Add a folder from the LOCAL machine via the vsfe-local scheme (works even over SSH). */
  async cmdAddLocalFolder(): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: 'Local folder on YOUR computer, e.g. C:\\Users\\You\\Desktop (works even over SSH)',
    });
    if (!input) {
      return;
    }
    const uri = LocalFsProvider.toUri(input);
    if (!(await this.reachable(uri))) {
      vscode.window.showErrorMessage('Local folder not found: ' + input);
      return;
    }
    await this.saveBookmarks([...this.getBookmarks(), uri]);
    this.activeKey = uri.toString();
    this.currentRoot = uri;
    this.postInit();
  }

  private async removeBookmark(uriStr: string): Promise<void> {
    const projKeys = new Set(this.projectFolders().map((u) => u.toString()));
    if (projKeys.has(uriStr)) {
      return; // project ("home") bookmark is permanent
    }
    const left = this.getBookmarks().filter((u) => u.toString() !== uriStr);
    await this.saveBookmarks(left);
    if (this.activeKey === uriStr) {
      this.activeKey = (this.projectFolders()[0] ?? left[0])?.toString();
      this.currentRoot = this.activeKey ? vscode.Uri.parse(this.activeKey) : undefined;
    }
    this.postInit();
  }

  async cmdResetToProject(): Promise<void> {
    const wf = this.projectFolders()[0];
    if (!wf) {
      vscode.window.showInformationMessage('No project folder is open (workspace).');
      return;
    }
    this.activeKey = wf.toString();
    this.currentRoot = wf;
    this.postInit();
  }

  cmdRefresh(): void {
    this.postRoot();
  }

  /** Open the in-webview filter box (real-time recursive search of the current bookmark). */
  async cmdSearch(): Promise<void> {
    this.post({ type: 'focusSearch' });
  }

  /** Recursive name filter within the current bookmark. Each call supersedes the previous one
   * (a new keystroke / Enter always cancels the search in flight). */
  private async doSearch(query: string): Promise<void> {
    const seq = ++this.searchSeq; // any newer search makes this one obsolete
    if (!this.currentRoot || !query) {
      return;
    }
    const root = this.currentRoot;
    const cfg = vscode.workspace.getConfiguration('vsfe');
    const exclude = new Set(cfg.get<string[]>('search.exclude', []));
    const maxResults = cfg.get<number>('search.maxResults', 5000);
    const ql = query.toLowerCase();
    await this.loadSeti();
    const items: any[] = [];
    const truncated = await walkMatches(
      root,
      exclude,
      maxResults,
      ql,
      (uri, isDir) => {
        items.push({
          uri: uri.toString(),
          name: baseName(uri),
          dir: isDir,
          icon: isDir ? undefined : this.iconFor(baseName(uri)),
          inProject: this.isInProject(uri),
          dragUri: uri.scheme === LOCAL_SCHEME ? vscode.Uri.file(toLocalPath(uri)).toString() : uri.toString(),
          rel: relTo(root, uri),
        });
      },
      () => seq !== this.searchSeq, // abort the walk as soon as a newer search starts
    );
    if (seq !== this.searchSeq) {
      return; // superseded — drop these results
    }
    this.post({ type: 'searchResults', query, items, truncated });
  }

  // ---- html ------------------------------------------------------------

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const setiUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'seti.woff'));
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src data:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  @font-face { font-family: 'seti'; src: url(${setiUri}) format('woff'); }
  html, body { height: 100%; margin: 0; padding: 0; }
  body { color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  #wrap { display: flex; flex-direction: row; height: 100vh; }
  #main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  #bar { display: flex; align-items: center; gap: 4px; padding: 2px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  #bar .path { flex: 1 1 auto; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  #bar button { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px 4px; opacity: .8; }
  #bar button:hover { opacity: 1; }
  #search { display: none; align-items: center; gap: 4px; padding: 2px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  #search.on { display: flex; }
  #search input { flex: 1 1 auto; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); outline: none; padding: 1px 4px; }
  #search button { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px 4px; opacity: .8; }
  #search button:hover { opacity: 1; }
  #qspin { display: none; flex: 0 0 auto; width: 12px; height: 12px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; opacity: .6; animation: vsfe-spin .7s linear infinite; }
  #qspin.on { display: block; }
  @keyframes vsfe-spin { to { transform: rotate(360deg); } }
  .row .rel { opacity: .55; font-size: 11px; margin-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srchinfo { opacity: .55; font-size: 11px; padding: 2px 6px 4px; }
  #tree { flex: 1 1 auto; overflow: auto; padding: 2px 0; }
  .row { display: flex; align-items: center; padding: 1px 0; cursor: pointer; white-space: nowrap; user-select: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .row.drop-target, .chip.drop-target { background: var(--vscode-list-dropBackground, var(--vscode-list-activeSelectionBackground)); outline: 1px dashed var(--vscode-focusBorder); outline-offset: -1px; }
  #preview { position: fixed; z-index: 200; display: none; pointer-events: none; padding: 4px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
    box-shadow: 0 2px 12px rgba(0,0,0,.45); }
  #preview img { max-width: 92vw; max-height: 92vh; display: block; background-color: #fff;
    background-image:
      linear-gradient(45deg, #c8c8c8 25%, transparent 25%),
      linear-gradient(-45deg, #c8c8c8 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #c8c8c8 75%),
      linear-gradient(-45deg, transparent 75%, #c8c8c8 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
  #info { position: fixed; z-index: 200; display: none; pointer-events: none; max-width: 320px;
    padding: 6px 9px; font-size: 11px; line-height: 1.55; white-space: normal; overflow-wrap: anywhere;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
    box-shadow: 0 2px 12px rgba(0,0,0,.45); }
  #info .nm { font-weight: 600; }
  #info .t { opacity: .6; }
  .row .tw { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; opacity: .8; }
  .row .tw svg { width: 16px; height: 16px; transition: transform .1s ease; }
  .row .tw.open svg { transform: rotate(90deg); }
  .row .ic { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; }
  .row .ic svg { width: 14px; height: 14px; }
  .row .ic.folder { color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground)); opacity: .9; }
  .ficon { font-family: 'seti'; font-size: 15px; line-height: 1; }
  .row .nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .row input.rename { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder); outline: none; padding: 0 2px; margin: 0; width: 100%; box-sizing: border-box; }
  .children { }
  #strip { flex: none; width: 26px; border-left: 1px solid var(--vscode-panel-border); overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; }
  .chip { writing-mode: vertical-rl; transform: rotate(180deg); padding: 10px 3px; cursor: pointer; white-space: nowrap; text-align: center; border-bottom: 1px solid var(--vscode-panel-border); overflow: hidden; text-overflow: ellipsis; max-height: 240px; font-size: 14px; letter-spacing: .3px; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .chip.add { writing-mode: horizontal-tb; transform: none; font-size: 16px; opacity: .8; padding: 6px 2px; }
  .chip.add:hover { opacity: 1; }
  .chip.home { writing-mode: horizontal-tb; transform: none; font-size: 14px; padding: 7px 2px; text-align: center; }
  #menu { position: fixed; z-index: 100; min-width: 150px; padding: 4px 0; display: none;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    box-shadow: 0 2px 8px rgba(0,0,0,.35); }
  #menu .mi { padding: 4px 16px; cursor: pointer; white-space: nowrap; }
  #menu .mi:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  #menu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
</style>
</head>
<body>
<div id="wrap">
  <div id="main">
    <div id="bar">
      <button id="up" title="Up">&#8593;</button>
      <button id="rf" title="Refresh">&#8635;</button>
      <button id="sb" title="Search">&#128269;</button>
      <span class="path" id="path"></span>
    </div>
    <div id="search">
      <input id="q" type="text" placeholder="Filter files…" spellcheck="false">
      <span id="qspin" title="Searching…"></span>
      <button id="qx" title="Clear">&#10005;</button>
    </div>
    <div id="tree"></div>
  </div>
  <div id="strip"></div>
</div>
<div id="menu"></div>
<div id="preview"><img alt=""></div>
<div id="info"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3h3.1a1 1 0 0 1 .7.3L6.5 4.7H14.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="#E3A93C"/><path d="M.5 6.3h15V12a1 1 0 0 1-1 1H1.5a1 1 0 0 1-1-1z" fill="#F4C44E"/></svg>';
let rootUri = null;
let curRootLabel = '';
const containers = new Map(); // uri -> children container element
const loaded = new Set();
const expanded = new Set(); // uris of folders the user has opened (to survive rebuilds)
let selectedEl = null;
let selectedItem = null;
let selection = []; // [{el, it}] — multi-selection
let anchor = null;  // {el, it} — for Shift range
let renaming = false;
let hoverUri = null;
let infoUri = null, infoTimer = null;
let mx = 0, my = 0;
const HOVER_DELAY = 700;
const INFO_DELAY = 2000; // hover this long over a row to get the size/info popup
const IMG = /\\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i;
const preview = $('preview');
const infoBox = $('info');
window.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });
function isSel(el){ return selection.some(s => s.el === el); }
function setPrimary(){ const last = selection[selection.length-1]; selectedEl = last ? last.el : null; selectedItem = last ? last.it : null; }
function clearSel(){ for (const s of selection) s.el.classList.remove('selected'); selection = []; setPrimary(); }
function addSel(el, it){ if (!isSel(el)){ selection.push({ el, it }); el.classList.add('selected'); } setPrimary(); }
function selSingle(el, it){ clearSel(); addSel(el, it); anchor = { el, it }; }
function selToggle(el, it){
  if (isSel(el)){ selection = selection.filter(s => s.el !== el); el.classList.remove('selected'); setPrimary(); }
  else { addSel(el, it); }
  anchor = { el, it };
}
function selRange(el, it){
  const rows = Array.from(document.querySelectorAll('#tree .row'));
  const bi = rows.indexOf(el);
  const ai = anchor ? rows.indexOf(anchor.el) : -1;
  if (ai < 0){ selSingle(el, it); return; }
  const lo = Math.min(ai, bi), hi = Math.max(ai, bi);
  clearSel();
  for (let i = lo; i <= hi; i++){ const r = rows[i]; if (r.__it) addSel(r, r.__it); }
}
function onRowClick(el, it, ev){
  if (ev.ctrlKey || ev.metaKey) selToggle(el, it);
  else if (ev.shiftKey) selRange(el, it);
  else selSingle(el, it);
}
function selKeys(){ return selection.map(s => s.it.uri); }
function selectRow(row, it){ selSingle(row, it); }
function startRename(row, it){
  if (renaming) return;
  renaming = true;
  hidePreview();
  const nm = row.querySelector('.nm');
  const oldName = it.name;
  row.draggable = false;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = oldName;
  nm.textContent = '';
  nm.appendChild(input);
  input.focus();
  const dot = it.dir ? -1 : oldName.lastIndexOf('.');
  if (dot > 0) input.setSelectionRange(0, dot); else input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true; renaming = false; row.draggable = true;
    const val = input.value.trim();
    if (commit && val && val !== oldName){
      nm.textContent = val; // optimistic; the parent refresh confirms it
      send({ type:'rename', uri: it.uri, newName: val });
    } else {
      nm.textContent = oldName;
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter'){ e.preventDefault(); finish(true); }
    else if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}
function hidePreview(){ preview.style.display = 'none'; }
// Place a popup beside the cursor — fully above or below it so it never covers the hovered
// row, and clamped inside the panel viewport (a webview can't draw outside its own area).
function placePopup(el){
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = el.offsetWidth || 200, h = el.offsetHeight || 120, gap = 16;
  let y;
  if (my + gap + h <= vh) y = my + gap;            // fits below the cursor
  else if (my - gap - h >= 0) y = my - gap - h;    // fits above the cursor
  else y = (vh - my >= my) ? (vh - h - 4) : 4;     // too tall for either side: pin to the roomier one
  let x = mx + gap;
  if (x + w > vw) x = mx - gap - w;
  x = Math.max(4, Math.min(x, vw - w - 4));
  el.style.left = x + 'px';
  el.style.top = Math.max(4, y) + 'px';
}
function showPreview(dataUri){
  const img = preview.querySelector('img');
  // Show the image at its natural size (CSS caps it at 92vw/92vh so it never leaves the window).
  img.onload = () => placePopup(preview);
  img.onerror = () => hidePreview(); // don't leave a dark square if the image can't decode
  img.src = dataUri;
  preview.style.display = 'block';
  placePopup(preview);
}
function attachPreview(row, uri){
  row.addEventListener('mouseenter', () => {
    hoverUri = uri;
    setTimeout(() => { if (hoverUri === uri) send({ type:'preview', uri }); }, HOVER_DELAY);
  });
  row.addEventListener('mouseleave', () => { if (hoverUri === uri){ hoverUri = null; hidePreview(); } });
}
function attachInfo(row, uri){
  row.addEventListener('mouseenter', () => {
    infoUri = uri;
    if (infoTimer) clearTimeout(infoTimer);
    infoTimer = setTimeout(() => { if (infoUri === uri) send({ type:'info', uri }); }, INFO_DELAY);
  });
  row.addEventListener('mouseleave', () => {
    if (infoUri === uri){ infoUri = null; if (infoTimer) clearTimeout(infoTimer); hideInfo(); }
  });
}
function hideInfo(){ infoBox.style.display = 'none'; }
function htmlEsc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function fmtBytes(n){
  if (n < 1024) return n + ' B';
  const u = ['KB','MB','GB','TB']; let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}
function fmtDate(ms){ try { return new Date(ms).toLocaleString(); } catch(e){ return ''; } }
function uriName(u){
  try { return decodeURIComponent(u.split('?')[0].split('#')[0].replace(/\\/+$/,'').split('/').pop()) || u; }
  catch(e){ return u; }
}
function showInfo(d, uri){
  const rows = ['<div class="nm">' + htmlEsc(uriName(uri)) + '</div>'];
  if (d.kind === 'file'){
    rows.push('<span class="t">Size:</span> ' + fmtBytes(d.size));
  } else {
    const ge = d.truncated ? '\\u2265\\u2009' : '';
    rows.push('<span class="t">Items here:</span> ' + d.items);
    rows.push('<span class="t">Total:</span> ' + ge + d.files + ' files, ' + ge + d.dirs + ' folders');
    rows.push('<span class="t">Size:</span> ' + ge + fmtBytes(d.bytes) + (d.truncated ? ' <span class="t">(partial)</span>' : ''));
  }
  if (d.mtime) rows.push('<span class="t">Modified:</span> ' + htmlEsc(fmtDate(d.mtime)));
  infoBox.innerHTML = rows.join('<br>');
  infoBox.style.display = 'block';
  placePopup(infoBox);
}

function send(m){ vscode.postMessage(m); }

function readDragSrc(dt){
  if (!dt) return '';
  let s = dt.getData('application/vnd.vsfe');
  if (!s){ const u = dt.getData('text/uri-list'); if (u) s = u.split('\\n')[0].trim(); }
  if (!s) s = dt.getData('text/plain');
  return s;
}
function addDropTarget(el, destFn){
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    el.classList.remove('drop-target');
    const src = readDragSrc(ev.dataTransfer);
    const dest = destFn();
    if (src && dest && src !== dest) send({ type:'dropTransfer', src, dest });
  });
}

const menu = $('menu');
function hideMenu(){ menu.style.display = 'none'; }
function showMenu(items, x, y){
  hidePreview();
  menu.innerHTML = '';
  for (const it of items){
    if (it.sep){
      if (!menu.lastChild || menu.lastChild.className === 'sep') continue;
      const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); continue;
    }
    const d = document.createElement('div'); d.className = 'mi'; d.textContent = it.label;
    d.addEventListener('click', () => { hideMenu(); it.action(); });
    menu.appendChild(d);
  }
  while (menu.lastChild && menu.lastChild.className === 'sep') menu.removeChild(menu.lastChild);
  menu.style.left = x + 'px'; menu.style.top = y + 'px'; menu.style.display = 'block';
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(2, window.innerWidth - r.width - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(2, window.innerHeight - r.height - 4) + 'px';
}
function rowMenu(it, ev, row){
  ev.preventDefault(); ev.stopPropagation();
  if (!isSel(row)) selSingle(row, it); // right-clicking outside the selection selects just this row
  const multi = selection.length > 1;
  const items = [];
  if (it.dir && !multi){
    items.push({ label:'New Folder', action:()=>send({ type:'newFolder', uri: it.uri }) });
    items.push({ label:'Add Bookmark', action:()=>send({ type:'bookmarkAdd', uri: it.uri }) });
    items.push({ label:'Paste', action:()=>send({ type:'paste', uri: it.uri }) });
    items.push({ sep:true });
  }
  items.push({ label: multi ? 'Copy ('+selection.length+')' : 'Copy', action:()=>send({ type:'copy', uris: selKeys() }) });
  if (!multi){
    items.push({ label:'Copy Path', action:()=>send({ type:'copyPath', uri: it.uri }) });
    if (it.inProject){ items.push({ label:'Copy Relative Path', action:()=>send({ type:'copyRelativePath', uri: it.uri }) }); }
    items.push({ sep:true });
    if (it.uri.indexOf('vsfe-local:') === 0 || it.uri.indexOf('file:') === 0){
      items.push({ label:'Reveal in File Explorer', action:()=>send({ type:'reveal', uri: it.uri }) });
    }
    items.push({ sep:true });
    items.push({ label:'Rename', action:()=>startRename(row, it) });
  }
  items.push({ label: multi ? 'Delete ('+selection.length+')' : 'Delete', action:()=>send({ type:'delete', uris: selKeys() }) });
  showMenu(items, ev.clientX, ev.clientY);
}
window.addEventListener('click', hideMenu);
window.addEventListener('scroll', () => { hideMenu(); hidePreview(); }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); hidePreview(); } });
window.addEventListener('keydown', (e) => {
  if (e.key === 'F2' && !renaming && selectedEl && selectedItem){
    e.preventDefault();
    startRename(selectedEl, selectedItem);
  } else if (e.key === 'Delete' && !renaming && selKeys().length){
    e.preventDefault();
    send({ type:'delete', uris: selKeys() });
  } else if (!renaming && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selKeys().length){
    e.preventDefault();
    send({ type:'copy', uris: selKeys() });
  } else if (!renaming && (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')){
    e.preventDefault();
    const dest = (selectedItem && selectedItem.dir) ? selectedItem.uri : rootUri;
    if (dest) send({ type:'paste', uri: dest });
  }
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'init') { renderStrip(m.bookmarks, m.active); setRoot(m.root, m.rootLabel); }
  else if (m.type === 'bookmarks') { renderStrip(m.bookmarks, m.active); }
  else if (m.type === 'root') { setRoot(m.root, m.rootLabel); }
  else if (m.type === 'children') { fillChildren(m.uri, m.items); }
  else if (m.type === 'searchResults') { renderResults(m.items, m.query, m.truncated); }
  else if (m.type === 'focusSearch') { openSearch(); }
  else if (m.type === 'requestBookmark') { const dir = (selectedItem && selectedItem.dir) ? selectedItem.uri : rootUri; if (dir) send({ type:'bookmarkAdd', uri: dir }); }
  else if (m.type === 'preview') { if (hoverUri && m.uri === hoverUri) showPreview(m.dataUri); }
  else if (m.type === 'info') { if (infoUri && m.uri === infoUri) showInfo(m.info, m.uri); }
});

function renderStrip(bookmarks, active){
  const strip = $('strip');
  strip.innerHTML = '';
  for (const b of bookmarks){
    const el = document.createElement('div');
    const isProj = b.kind === 'project';
    el.className = 'chip' + (isProj ? ' home' : '') + (b.uri === active ? ' active' : '');
    el.textContent = isProj ? '\\uD83C\\uDFE0' : (b.name || b.uri);
    el.title = isProj ? (b.name + ' (project)') : b.uri;
    el.addEventListener('click', () => send({ type:'switch', uri: b.uri }));
    if (!isProj){
      el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); send({ type:'remove', uri: b.uri }); });
    }
    addDropTarget(el, () => b.uri); // drop onto a chip → copy/move into that bookmarked folder (incl. 🏠)
    strip.appendChild(el);
  }
  const add = document.createElement('div');
  add.className = 'chip add';
  add.textContent = '+';
  add.title = 'Add bookmark';
  add.addEventListener('click', () => send({ type:'add' }));
  strip.appendChild(add);
}

function setRoot(uri, label){
  rootUri = uri || null;
  curRootLabel = label || '';
  $('path').textContent = label || '';
  containers.clear();
  loaded.clear();
  expanded.clear();
  selection = [];
  anchor = null;
  selectedEl = null;
  selectedItem = null;
  hoverUri = null;
  infoUri = null;
  hidePreview();
  hideInfo();
  const tree = $('tree');
  tree.innerHTML = '';
  if (!rootUri) return;
  const box = document.createElement('div');
  box.className = 'children';
  tree.appendChild(box);
  containers.set(rootUri, box);
  requestChildren(rootUri);
}

function requestChildren(uri){
  if (loaded.has(uri)) return;
  loaded.add(uri);
  send({ type:'children', uri });
}

function fillChildren(parent, items){
  const box = containers.get(parent);
  if (!box) return;
  // Drop stale descendant containers (their DOM is about to be wiped) so they
  // reload when re-expanded instead of staying blank because 'loaded' still flags them.
  for (const [k, el] of Array.from(containers)){
    if (k !== parent && box.contains(el)){ containers.delete(k); loaded.delete(k); }
  }
  box.innerHTML = '';
  loaded.add(parent);
  const depth = box.dataset.depth ? parseInt(box.dataset.depth) : 0;
  for (const it of items){
    const row = document.createElement('div');
    row.className = 'row';
    row.__it = it;
    row.style.paddingLeft = (depth * 12 + 4) + 'px';
    const tw = document.createElement('span');
    tw.className = 'tw';
    if (it.dir){ tw.innerHTML = CHEVRON; }
    const ic = document.createElement('span');
    if (it.dir){ ic.className = 'ic folder'; ic.innerHTML = FOLDER; }
    else if (it.icon){ ic.className = 'ic ficon'; ic.textContent = it.icon.ch; if (it.icon.color){ ic.style.color = it.icon.color; } }
    else { ic.className = 'ic'; }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;
    row.appendChild(tw); row.appendChild(ic); row.appendChild(nm);
    row.addEventListener('contextmenu', (ev) => rowMenu(it, ev, row));
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
      if (!ev.dataTransfer) return;
      const u = it.dragUri || it.uri;
      ev.dataTransfer.effectAllowed = 'copyMove'; // move by default, copy with Ctrl
      ev.dataTransfer.setData('application/vnd.vsfe', it.uri); // original scheme, for in-tree drop
      ev.dataTransfer.setData('text/uri-list', u);
      ev.dataTransfer.setData('text/plain', u);
    });
    box.appendChild(row);
    if (it.dir){
      const sub = document.createElement('div');
      sub.className = 'children';
      sub.dataset.depth = depth + 1;
      sub.style.display = 'none';
      box.appendChild(sub);
      containers.set(it.uri, sub);
      row.addEventListener('click', (ev) => onRowClick(row, it, ev));
      row.addEventListener('dblclick', () => toggle(it.uri, tw, sub)); // double-click name/icon opens the folder
      tw.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(it.uri, tw, sub); }); // single-click the arrow toggles
      addDropTarget(row, () => it.uri); // drop a file/folder onto this folder → copy/move into it
      attachInfo(row, it.uri); // hover >2s → folder size & item counts
      if (expanded.has(it.uri)){ sub.style.display = ''; tw.classList.add('open'); requestChildren(it.uri); } // survive parent rebuilds
    } else {
      row.addEventListener('click', (ev) => onRowClick(row, it, ev));
      row.addEventListener('dblclick', () => send({ type:'open', uri: it.uri }));
      if (IMG.test(it.name)) attachPreview(row, it.uri); else attachInfo(row, it.uri); // image → preview, else hover → size
    }
  }
}

function toggle(uri, tw, sub){
  if (sub.style.display === 'none'){
    sub.style.display = '';
    tw.classList.add('open');
    expanded.add(uri);
    requestChildren(uri);
  } else {
    sub.style.display = 'none';
    tw.classList.remove('open');
    expanded.delete(uri);
  }
}

$('up').addEventListener('click', () => send({ type:'up' }));
$('rf').addEventListener('click', () => send({ type:'refresh' }));
$('tree').addEventListener('contextmenu', (ev) => {
  if (ev.target.closest && ev.target.closest('.row')) return;
  ev.preventDefault();
  if (!rootUri) return;
  showMenu([
    { label:'New Folder', action:()=>send({ type:'newFolder', uri: rootUri }) },
    { label:'Paste', action:()=>send({ type:'paste', uri: rootUri }) },
  ], ev.clientX, ev.clientY);
});
addDropTarget($('tree'), () => rootUri); // drop onto empty tree area → into the current folder

// ---- live search / filter ----
let searchTimer = null;
const searchRow = $('search');
const q = $('q');
function openSearch(){ searchRow.classList.add('on'); q.focus(); q.select(); }
function closeSearch(){ searchRow.classList.remove('on'); q.value = ''; exitSearch(); }
function exitSearch(){ $('qspin').classList.remove('on'); if (rootUri) setRoot(rootUri, curRootLabel); }
$('sb').addEventListener('click', () => { if (searchRow.classList.contains('on')) closeSearch(); else openSearch(); });
$('qx').addEventListener('click', () => closeSearch());
q.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  const query = q.value.trim();
  if (!query) { $('qspin').classList.remove('on'); exitSearch(); return; }
  $('qspin').classList.add('on'); // show the spinner right away — SSH searches are slow
  searchTimer = setTimeout(() => { send({ type:'search', query }); }, 200);
});
q.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchTimer) clearTimeout(searchTimer);
    const query = q.value.trim();
    if (!query) { exitSearch(); return; }
    $('qspin').classList.add('on');
    send({ type:'search', query }); // restart now — re-runs against the current bookmark, supersedes any running search
  }
});
function renderResults(items, query, truncated){
  if (!searchRow.classList.contains('on')) return;
  if (q.value.trim() !== query) return; // stale response — keep the spinner, the live query is still running
  $('qspin').classList.remove('on');
  containers.clear(); loaded.clear(); selection = []; anchor = null; selectedEl = null; selectedItem = null; hoverUri = null; infoUri = null; hidePreview(); hideInfo();
  const tree = $('tree');
  tree.innerHTML = '';
  const info = document.createElement('div');
  info.className = 'srchinfo';
  info.textContent = items.length
    ? (truncated ? items.length + '+ matches (stopped early — refine the query)' : items.length + (items.length === 1 ? ' match' : ' matches'))
    : 'No matches';
  tree.appendChild(info);
  for (const it of items){
    const row = document.createElement('div');
    row.className = 'row';
    row.__it = it;
    row.style.paddingLeft = '4px';
    const ic = document.createElement('span');
    if (it.dir){ ic.className = 'ic folder'; ic.innerHTML = FOLDER; }
    else if (it.icon){ ic.className = 'ic ficon'; ic.textContent = it.icon.ch; if (it.icon.color){ ic.style.color = it.icon.color; } }
    else { ic.className = 'ic'; }
    const nm = document.createElement('span'); nm.className = 'nm'; nm.style.flex = '0 1 auto'; nm.textContent = it.name;
    const rel = document.createElement('span'); rel.className = 'rel'; rel.textContent = it.rel || '';
    row.appendChild(ic); row.appendChild(nm); row.appendChild(rel);
    row.addEventListener('contextmenu', (ev) => rowMenu(it, ev, row));
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
      if (!ev.dataTransfer) return;
      const u = it.dragUri || it.uri;
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData('application/vnd.vsfe', it.uri);
      ev.dataTransfer.setData('text/uri-list', u);
      ev.dataTransfer.setData('text/plain', u);
    });
    if (it.dir){
      row.addEventListener('click', (ev) => onRowClick(row, it, ev));
      row.addEventListener('dblclick', () => send({ type:'switch', uri: it.uri }));
      attachInfo(row, it.uri);
    } else {
      row.addEventListener('click', (ev) => onRowClick(row, it, ev));
      row.addEventListener('dblclick', () => send({ type:'open', uri: it.uri }));
      if (IMG.test(it.name)) attachPreview(row, it.uri); else attachInfo(row, it.uri);
    }
    tree.appendChild(row);
  }
}
send({ type:'ready' });
</script>
</body>
</html>`;
  }
}

// ---- helpers ------------------------------------------------------------

/** Extension → languageId fallback, for files Seti maps only by language (e.g. C#). */
const EXT2LANG: Record<string, string> = {
  cs: 'csharp', csx: 'csharp', vb: 'vb', fs: 'fsharp', fsx: 'fsharp',
  cshtml: 'razor', razor: 'razor', vbhtml: 'razor',
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  php: 'php', c: 'c', h: 'cpp', hpp: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  json: 'json', jsonc: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell',
  sql: 'sql', lua: 'lua', swift: 'swift', dart: 'dart', vue: 'vue', svelte: 'svelte', r: 'r',
};

/** Detect the real image format from magic bytes. A file named ".ico" is often actually a PNG or SVG,
 * and a data: URI is decoded strictly by its declared MIME, so a wrong label renders nothing. */
function sniffMime(data: Uint8Array, name: string): string {
  const b = data;
  const at = (off: number, sig: number[]): boolean => sig.every((v, i) => b[off + i] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x42, 0x4d])) return 'image/bmp';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (at(4, [0x66, 0x74, 0x79, 0x70])) return 'image/avif'; // ISO-BMFF 'ftyp' box (avif/heif family)
  if (at(0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 256)).trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return mimeForName(name);
}

function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'ico': return 'image/x-icon';
    case 'avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}

/** Seti stores glyphs as "\\Exxx"; convert to the actual character. */
function setiChar(fc: string): string {
  const hex = (fc || '').replace(/\\/g, '');
  const code = parseInt(hex, 16);
  return Number.isNaN(code) ? '' : String.fromCodePoint(code);
}

function safeParse(s: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(s);
  } catch {
    return undefined;
  }
}

function dedupe(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const u of uris) {
    const k = u.toString();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(u);
    }
  }
  return out;
}

function baseName(uri: vscode.Uri): string {
  return path.posix.basename(uri.path) || uri.path;
}

function compareEntries(a: [string, vscode.FileType], b: [string, vscode.FileType]): number {
  const ad = (a[1] & vscode.FileType.Directory) !== 0;
  const bd = (b[1] & vscode.FileType.Directory) !== 0;
  if (ad !== bd) {
    return ad ? -1 : 1;
  }
  return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
}

function relTo(root: vscode.Uri, uri: vscode.Uri): string {
  if (uri.path.startsWith(root.path)) {
    return uri.path.slice(root.path.length).replace(/^\//, '');
  }
  return uri.path;
}

function toLocalPath(uri: vscode.Uri): string {
  return /^\/[a-zA-Z]:/.test(uri.path) ? uri.path.slice(1) : uri.path;
}

function displayPath(uri: vscode.Uri): string {
  if (uri.scheme === LOCAL_SCHEME) {
    return toLocalPath(uri) + ' (local)';
  }
  const p = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return uri.authority ? `${uri.authority}:${p}` : p;
}

function getNonce(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    t += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return t;
}

async function walkMatches(
  root: vscode.Uri,
  exclude: Set<string>,
  maxResults: number,
  ql: string,
  onMatch: (uri: vscode.Uri, isDir: boolean) => void,
  cancelled?: () => boolean,
): Promise<boolean> {
  let count = 0;
  // Safety budget: a home directory over SSH is huge and every readDirectory is a
  // network round-trip, so an unbounded walk would appear to hang. The search is also
  // cancellable (a new keystroke supersedes it), so we can afford a generous budget —
  // it mainly stops a single search from running forever in the background.
  const deadline = Date.now() + 30000;
  const queue: vscode.Uri[] = [root];
  while (queue.length) {
    if (cancelled?.() || Date.now() > deadline) {
      return true;
    }
    const dir = queue.shift()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (name.toLowerCase().includes(ql)) {
        onMatch(child, isDir);
        if (++count >= maxResults) {
          return true;
        }
      }
      // Skip excluded names and symlinked directories — symlinks in a home dir can
      // form cycles (e.g. ~/foo -> ~) that would loop the walk forever.
      if (isDir && !exclude.has(name) && (type & vscode.FileType.SymbolicLink) === 0) {
        queue.push(child);
      }
    }
  }
  return false;
}
