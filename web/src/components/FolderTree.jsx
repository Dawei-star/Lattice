import { useState } from 'react';
import { CloseIcon, PencilIcon } from './icons.jsx';

/**
 * 目录树。递归渲染任意层级，支持就地重命名与删除。
 * 点「未分类」可筛选出没有归属目录的笔记。
 */
export default function FolderTree({ nodes, filter, onSelectFolder, onDeleteFolder, onRenameFolder }) {
  if (!nodes?.length) {
    return <p className="empty-hint">还没有目录，点上方 + 新建一个。</p>;
  }

  return (
    <ul className="tree" role="tree">
      {nodes.map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          depth={0}
          filter={filter}
          onSelectFolder={onSelectFolder}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
        />
      ))}
      <li>
        <button
          type="button"
          className={`nav-item nav-item--muted ${filter.kind === 'folder' && filter.folderId === null ? 'is-active' : ''}`}
          onClick={() => onSelectFolder(null)}
        >
          <span className="nav-item__label">未分类</span>
        </button>
      </li>
    </ul>
  );
}

function FolderNode({ node, depth, filter, onSelectFolder, onDeleteFolder, onRenameFolder }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const isActive = filter.kind === 'folder' && filter.folderId === node.id;
  const hasChildren = node.children?.length > 0;

  const commitRename = async () => {
    const name = draftName.trim();
    if (name && name !== node.name) {
      const ok = await onRenameFolder(node.id, name);
      if (!ok) {
        setDraftName(node.name);
        return;
      }
    } else {
      setDraftName(node.name);
    }
    setRenaming(false);
  };

  const confirmDelete = () => {
    const extra = node.noteCount > 0 ? `其中的 ${node.noteCount} 篇笔记会回到「未分类」，不会被删除。` : '';
    if (window.confirm(`确定删除目录「${node.name}」及其子目录吗？${extra}`)) {
      onDeleteFolder(node.id);
    }
  };

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      {renaming ? (
        <form
          className="inline-form inline-form--inline"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            autoFocus
            value={draftName}
            maxLength={120}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraftName(node.name);
                setRenaming(false);
              }
            }}
          />
        </form>
      ) : (
        <div className={`nav-item ${isActive ? 'is-active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          <button
            type="button"
            className={`tree__caret ${hasChildren ? '' : 'is-hidden'}`}
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? '折叠' : '展开'}
            tabIndex={hasChildren ? 0 : -1}
          >
            <span className={`caret ${expanded ? '' : 'is-collapsed'}`} aria-hidden="true">▾</span>
          </button>

          <button type="button" className="nav-item__main" onClick={() => onSelectFolder(node.id)}>
            <span className="nav-item__label" title={node.name}>{node.name}</span>
            {node.noteCount > 0 ? <span className="nav-item__badge">{node.noteCount}</span> : null}
          </button>

          <span className="nav-item__tools">
            <button type="button" className="icon-btn" title="重命名" onClick={() => setRenaming(true)}>
              <PencilIcon />
            </button>
            <button type="button" className="icon-btn icon-btn--danger" title="删除目录" onClick={confirmDelete}>
              <CloseIcon />
            </button>
          </span>
        </div>
      )}

      {hasChildren && expanded ? (
        <ul role="group">
          {node.children.map((child) => (
            <FolderNode
              key={child.id}
              node={child}
              depth={depth + 1}
              filter={filter}
              onSelectFolder={onSelectFolder}
              onDeleteFolder={onDeleteFolder}
              onRenameFolder={onRenameFolder}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
