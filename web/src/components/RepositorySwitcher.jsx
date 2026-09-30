import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, CircleHelp } from 'lucide-react';
import { createPortal } from 'react-dom';
import { vaultApi } from '../api/vault.js';
import Modal from '../ui/Modal.jsx';
import { useToast } from '../hooks/useToast.jsx';

const STORAGE_KEY = 'lattice-repositories';

function normalizePath(value) {
  return typeof value === 'string' ? value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : '';
}

function repositoryName(path) {
  const cleanPath = String(path ?? '').replace(/[\\/]+$/, '');
  return cleanPath.split(/[\\/]/).pop() || '本地知识库';
}

function loadRepositories() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item) => item && typeof item.path === 'string' && item.path.trim()).slice(0, 8);
  } catch {
    return [];
  }
}

function saveRepositories(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {
    // Private browsing can make localStorage unavailable; the current session still works.
  }
}

export default function RepositorySwitcher() {
  const toast = useToast();
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [currentPath, setCurrentPath] = useState('');
  const [repositories, setRepositories] = useState(loadRepositories);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const loadCurrentPath = async () => {
      try {
        const info = await (window.latticeDesktop?.getVaultInfo?.() ?? vaultApi.info());
        const path = info?.path ?? info?.vaultDir;
        if (!cancelled && path) setCurrentPath(path);
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
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setMenuOpen(false);
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
    const left = Math.min(Math.max(8, rect?.right - menuWidth), window.innerWidth - menuWidth - 8);
    setMenuStyle({ left: `${left}px`, top: `${Math.max(8, (rect?.top ?? 8) - 8)}px` });
    setMenuOpen(true);
  };

  const rememberRepository = (path) => {
    if (!path) return;
    const next = [
      { name: repositoryName(path), path },
      ...repositories.filter((item) => normalizePath(item.path) !== normalizePath(path)),
    ];
    setRepositories(next);
    saveRepositories(next);
  };

  const chooseRepository = async (repository) => {
    setMenuOpen(false);
    if (!repository?.path || normalizePath(repository.path) === normalizePath(currentPath)) return;

    const selectPath = window.latticeDesktop?.selectVaultPath;
    if (typeof selectPath !== 'function') {
      toast.info('浏览器开发模式暂不支持切换本地仓库', { detail: repository.path });
      return;
    }

    setBusy(true);
    try {
      const result = await selectPath(repository.path);
      if (result?.canceled) return;
      rememberRepository(result?.path ?? repository.path);
      toast.info('正在切换仓库，应用将自动重启');
    } catch (error) {
      toast.error(error?.message ?? '切换仓库失败');
    } finally {
      setBusy(false);
    }
  };

  const openRepositoryPicker = async () => {
    setMenuOpen(false);
    const selectVault = window.latticeDesktop?.selectVault;
    if (typeof selectVault !== 'function') {
      toast.info('请在 Lattice 桌面版中打开本地仓库');
      return;
    }

    setBusy(true);
    try {
      const result = await selectVault();
      if (result?.canceled) return;
      if (result?.path) rememberRepository(result.path);
      toast.info('正在打开仓库，应用将自动重启');
    } catch (error) {
      toast.error(error?.message ?? '打开仓库失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div ref={rootRef} className="repository-switcher">
        {menuOpen ? createPortal(
          <div ref={menuRef} className="repository-menu" role="menu" aria-label="切换仓库" style={menuStyle}>
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
