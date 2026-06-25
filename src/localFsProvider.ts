import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { Dirent } from 'fs';

/**
 * File system provider for the `vsfe-local:` scheme, backed by the local machine's
 * disk via Node `fs`. Because the extension runs as a UI extension (locally) even in
 * a Remote-SSH window, this lets the explorer browse AND open LOCAL files from inside
 * a remote window — the normal `file:` scheme there points at the remote host instead.
 *
 * URI shape: vsfe-local:/C:/Users/Name/Desktop  (path keeps a leading slash).
 */
export const LOCAL_SCHEME = 'vsfe-local';

export class LocalFsProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  /** vsfe-local:/C:/path -> C:/path ; vsfe-local:/home/x -> /home/x */
  private toFsPath(uri: vscode.Uri): string {
    const p = uri.path;
    return /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p;
  }

  static toUri(localPath: string): vscode.Uri {
    let p = localPath.trim().replace(/\\/g, '/');
    if (!p.startsWith('/')) {
      p = '/' + p;
    }
    return vscode.Uri.from({ scheme: LOCAL_SCHEME, path: p });
  }

  watch(uri: vscode.Uri, options: { recursive: boolean }): vscode.Disposable {
    let w: fsSync.FSWatcher | undefined;
    const base = uri.path.endsWith('/') ? uri.path.slice(0, -1) : uri.path;
    try {
      w = fsSync.watch(this.toFsPath(uri), { recursive: options.recursive }, (_event, filename) => {
        if (filename == null) {
          return;
        }
        const rel = filename.toString().replace(/\\/g, '/');
        const changed = uri.with({ path: base + '/' + rel });
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: changed }]);
      });
    } catch {
      /* path gone or not watchable — no events */
    }
    return new vscode.Disposable(() => w?.close());
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const s = await fs.stat(this.toFsPath(uri));
      return {
        type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.toFsPath(uri), { withFileTypes: true });
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entries.map((d) => [d.name, d.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fs.readFile(this.toFsPath(uri)));
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const p = this.toFsPath(uri);
    if (!options.create || !options.overwrite) {
      const exists = await fs
        .stat(p)
        .then(() => true)
        .catch(() => false);
      if (!exists && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (exists && options.create && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
    }
    await fs.writeFile(p, content);
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await fs.mkdir(this.toFsPath(uri), { recursive: true });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await fs.rm(this.toFsPath(uri), { recursive: options.recursive, force: true });
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    await fs.rename(this.toFsPath(oldUri), this.toFsPath(newUri));
  }
}
