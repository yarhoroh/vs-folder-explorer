import * as vscode from 'vscode';
import { ExplorerViewProvider } from './explorerViewProvider';
import { LocalFsProvider, LOCAL_SCHEME } from './localFsProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ExplorerViewProvider(context.globalState, context.extensionUri);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(LOCAL_SCHEME, new LocalFsProvider(), {
      isCaseSensitive: false,
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('vsfe.explorerView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('vsfe.addBookmark', () => provider.cmdAddBookmark());
  reg('vsfe.addLocalFolder', () => provider.cmdAddLocalFolder());
  reg('vsfe.bookmarkCurrent', () => provider.cmdBookmarkCurrent());
  reg('vsfe.search', () => provider.cmdSearch());
  reg('vsfe.resetToProject', () => provider.cmdResetToProject());
  reg('vsfe.refresh', () => provider.cmdRefresh());

  reg('vsfe.diagnostics', () => {
    const ext = vscode.extensions.getExtension('local.vs-folder-explorer');
    const kind =
      ext?.extensionKind === vscode.ExtensionKind.UI
        ? 'UI (local machine)'
        : ext?.extensionKind === vscode.ExtensionKind.Workspace
          ? 'Workspace (remote machine)'
          : String(ext?.extensionKind);
    vscode.window.showInformationMessage(
      `Folder Explorer runs as: ${kind} · remoteName=${vscode.env.remoteName ?? 'none'} · platform=${process.platform}`,
    );
  });
}

export function deactivate(): void {
  /* nothing to dispose */
}
