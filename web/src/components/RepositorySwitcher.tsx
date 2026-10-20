import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronsUpDown, CircleHelp } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import { createPortal } from 'react-dom';
import { vaultApi } from '../api/vault.ts';
import Modal from '../ui/Modal.tsx';
import { useToast } from '../hooks/useToast.tsx';
import type { LatticeDesktopVaultInfo } from '../api/vault-files.ts';
import type { FileConfirmationResult, FileOperationInput } from '../hooks/useFileConfirmation.tsx';

/** 记忆过的仓库条目（localStorage 持久化）。 */
export interface SavedRepository {
  name?: string;
  path: string;
}

export interface RepositorySwitcherProps {
  onConfirmFileOperation?: (operation: FileOperationInput) => Promise<FileConfirmationResult | null | undefined>;
}

const STORAGE_KEY = 'lattice-repositories';

function normalizePath(value: unknown): string {
  return typeof value === 'string' ? value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : '';
}

function repositoryName(path?: string | null): string {
  const cleanPath = String(path ?? '').replace(/[\\/]+$/, '');
  return cleanPath.split(/[\\/]/).pop() || '本地知识库';
}

function loadRepositories(): SavedRepository[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item) => item && typeof item.path === 'string' && item.path.trim()).slice(0, 8);
  } catch {
    return [];
  }
}

function saveRepositories(items: SavedRepository[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {
    // Private browsing can make localStorage unavailable; the current session still works.
  }
}

type VaultSelectionResult = { canceled?: boolean; path?: string } | null;

/**
 * The current desktop build is Tauri 2 and does not inject the legacy
 * `window.latticeDesktop` bridge. Keep the bridge path for older shells, but
 * use the native dialog and the already-registered Rust command when present.
 */
async function selectVaultWithTauri(_confirmation?: FileConfirmationResult | Record<string, unknown>): Promise<VaultSelectionResult> {
  if (!isTauri()) return null;
  const selected = await openDirectoryDialog({
    directory: true,
    multiple: false,
    title: '选择知识库目录',
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (typeof path !== 'string' || !path.trim()) return { canceled: true };
  await invoke<LatticeDesktopVaultInfo>('vault_open', { path });
  return { path };
}

async function openVaultPathWithTauri(path: string, _confirmation?: FileConfirmationResult | Record<string, unknown>): Promise<VaultSelectionResult> {
  if (!isTauri()) return null;
  await invoke<LatticeDesktopVaultInfo>('vault_open', { path });
  return { path };
}

export default function RepositorySwitcher({ onConfirmFileOperation }: RepositorySwitcherProps) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [repositories, setRepositories] = useState<SavedRepository[]>(loadRepositories);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadCurrentPath = async () => {
      try {
        const info = await (window.latticeDesktop?.getVaultInfo?.() ?? vaultApi.info());
        const path = info?.path ?? info?.vaultDir;
        if (!cancelled && path) setCurrentPath(path as string);
      } catch {
        // The workbench can still show the repository manager when the backend is offline.
      }
    };
    loadCurrentPath();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentPath) return;
    setRepositories((current) => {
      const next = [
        { name: repositoryName(currentPath), path: currentPath },
        ...current.filter((item) => normalizePath(item.path) !== normalizePath(currentPath)),
      ];
      saveRepositories(next);
      return next;
    });
  }, [currentPath]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null) && !menuRef.current?.contains(event.target as Node | null)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpen]);

  const visibleRepositories = useMemo(() => {
    const items = currentPath && !repositories.some((item) => normalizePath(item.path) === normalizePath(currentPath))
      ? [{ name: repositoryName(currentPath), path: currentPath }, ...repositories]
      : repositories;
    return items.slice(0, 6);
  }, [currentPath, repositories]);

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    const menuWidth = Math.min(300, window.innerWidth - 16);
    const left = Math.min(Math.max(8, (rect?.right as number) - menuWidth), window.innerWidth - menuWidth - 8);
    setMenuStyle({ left: `${left}px`, top: `${Math.max(8, (rect?.top ?? 8) - 8)}px` });
    setMenuOpen(true);
  };

  const rememberRepository = (path: string) => {
    if (!path) return;
    const next = [
      { name: repositoryName(path), path },
      ...repositories.filter((item) => normalizePath(item.path) !== normalizePath(path)),
    ];
    setRepositories(next);
    saveRepositories(next);
  };

  const chooseRepository = async (repository: SavedRepository) => {
    setMenuOpen(false);
    if (!repository?.path || normalizePath(repository.path) === normalizePath(currentPath)) return;

    const legacySelectPath = window.latticeDesktop?.selectVaultPath;
    const selectPath = legacySelectPath ?? (isTauri() ? openVaultPathWithTauri : undefined);
    if (typeof selectPath !== 'function') {
      toast.info('浏览器开发模式暂不支持切换本地仓库', { detail: repository.path });
      return;
    }

    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir: currentPath,
        type: 'update',
        path: '.lattice/vault-config.json',
        targetPath: repository.path,
        contentSummary: `切换当前知识库到 ${repository.path}`,
        impact: '修改 1 个桌面配置文件，并重启应用挂载新的知识库',
      });
      if (!confirmation?.confirmed) return;
      const result = await selectPath(repository.path, confirmation as unknown as Record<string, unknown>);
      if (result?.canceled) return;
      rememberRepository(result?.path ?? repository.path);
      toast.info('正在切换仓库，工作区即将刷新');
      if (!legacySelectPath && isTauri()) window.setTimeout(() => window.location.reload(), 60);
    } catch (error) {
      toast.error((error as Error)?.message ?? '切换仓库失败');
    } finally {
      setBusy(false);
    }
  };

  const openRepositoryPicker = async () => {
    setMenuOpen(false);
    const legacySelectVault = window.latticeDesktop?.selectVault;
    const selectVault = legacySelectVault ?? (isTauri() ? selectVaultWithTauri : undefined);
    if (typeof selectVault !== 'function') {
      toast.info('请在 Lattice 桌面版中打开本地仓库');
      return;
    }

    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir: currentPath,
        type: 'update',
        path: '.lattice/vault-config.json',
        contentSummary: '选择并挂载新的本地知识库目录',
        impact: '修改 1 个桌面配置文件，并重启应用挂载新的知识库',
      });
      if (!confirmation?.confirmed) return;
      const result = await selectVault(confirmation as unknown as Record<string, unknown>);
      if (result?.canceled) return;
      if (result?.path) rememberRepository(result.path);
      toast.info('正在打开仓库，工作区即将刷新');
      if (!legacySelectVault && isTauri()) window.setTimeout(() => window.location.reload(), 60);
    } catch (error) {
      toast.error((error as Error)?.message ?? '打开仓库失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div ref={rootRef} className="repository-switcher">
        {menuOpen ? createPortal(
          <div ref={menuRef} className="repository-menu" role="menu" aria-label="切换仓库" style={menuStyle ?? undefined}>
            <div className="repository-menu__label">最近打开</div>
            {visibleRepositories.length ? visibleRepositories.map((repository) => {
              const isCurrent = normalizePath(repository.path) === normalizePath(currentPath);
              return (
                <button
                  key={repository.path}
                  type="button"
                  role="menuitem"
                  className={`repository-menu__item ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => chooseRepository(repository)}
                  title={repository.path}
                  disabled={busy}
                >
                  <span className="repository-menu__mark" aria-hidden="true">⌂</span>
                  <span className="repository-menu__copy">
                    <strong>{repository.name}</strong>
                    <small>{repository.path}</small>
                  </span>
                  {isCurrent ? <span className="repository-menu__check" aria-label="当前仓库">✓</span> : null}
                </button>
              );
            }) : <div className="repository-menu__empty">还没有其他仓库</div>}
            <div className="repository-menu__separator" />
            <button
              type="button"
              role="menuitem"
              className="repository-menu__manage"
              onClick={() => {
                setMenuOpen(false);
                setManagerOpen(true);
              }}
            >
              <span aria-hidden="true">⚙</span>
              <span>管理仓库…</span>
              <span className="repository-menu__shortcut">⌘O</span>
            </button>
          </div>,
          document.body,
        ) : null}

        <button
          type="button"
          className="repository-switcher__trigger"
          onClick={toggleMenu}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title={currentPath || '当前仓库'}
          disabled={busy}
        >
          <span className="repository-switcher__chevron" aria-hidden="true">
            <ChevronsUpDown size={17} strokeWidth={1.8} />
          </span>
          <span className="repository-switcher__identity">
            <strong>Lattice</strong>
          </span>
        </button>

        <div className="repository-switcher__actions">
          <button type="button" className="repository-switcher__icon" title="仓库帮助" aria-label="仓库帮助" onClick={() => toast.info('一个仓库对应一个本地文件夹，Markdown 文件会保存在其中。')}>
            <CircleHelp size={21} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </div>

      {createPortal(
        <Modal open={managerOpen} onClose={() => setManagerOpen(false)} title="管理仓库" ariaLabel="管理仓库" className="repository-manager-modal">
          <div className="repository-manager">
            <header className="repository-manager__header">
              <div>
                <span className="repository-manager__eyebrow">LATTICE / REPOSITORIES</span>
                <h2>管理仓库</h2>
                <p>每个仓库都是一个本地文件夹，笔记和附件都保存在里面。</p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setManagerOpen(false)} aria-label="关闭仓库管理">×</button>
            </header>

            <div className="repository-manager__list">
              {visibleRepositories.map((repository) => {
                const isCurrent = normalizePath(repository.path) === normalizePath(currentPath);
                return (
                  <article key={repository.path} className={`repository-manager__row ${isCurrent ? 'is-current' : ''}`}>
                    <div className="repository-manager__avatar" aria-hidden="true">⌂</div>
                    <div className="repository-manager__details">
                      <div className="repository-manager__name-line">
                        <strong>{repository.name}</strong>
                        {isCurrent ? <span className="repository-manager__current">当前</span> : null}
                      </div>
                      <span title={repository.path}>{repository.path}</span>
                    </div>
                    <button type="button" className="btn btn--sm" disabled={isCurrent || busy} onClick={() => chooseRepository(repository)}>
                      {isCurrent ? '已打开' : '打开'}
                    </button>
                  </article>
                );
              })}
              {!visibleRepositories.length ? <div className="repository-manager__empty">还没有记录过其他仓库。</div> : null}
            </div>

            <footer className="repository-manager__footer">
              <button type="button" className="btn" onClick={openRepositoryPicker} disabled={busy}>
                <span aria-hidden="true">＋</span>
                打开其他仓库
              </button>
              <button type="button" className="btn btn--primary" onClick={openRepositoryPicker} disabled={busy}>
                新建仓库
              </button>
            </footer>
          </div>
        </Modal>,
        document.body,
      )}
    </>
  );
}
