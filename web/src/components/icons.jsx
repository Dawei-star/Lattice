/**
 * 项目内共享的内联 SVG 图标。
 * 统一 16x16 viewBox + currentColor 描边/填充，尺寸完全交给 CSS 控制，
 * 因此同一个图标可以同时用在工具栏（15px）与导航栏（20px）而不失真。
 */

/** 图标外框：所有图标共用，避免每个组件重复写 svg 属性 */
function Glyph({ className = 'icon icon--sm', children }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      {children}
    </svg>
  );
}

export function CloseIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M4.3 4.3a1 1 0 0 1 1.4 0L8 6.6l2.3-2.3a1 1 0 1 1 1.4 1.4L9.4 8l2.3 2.3a1 1 0 0 1-1.4 1.4L8 9.4l-2.3 2.3a1 1 0 0 1-1.4-1.4L6.6 8 4.3 5.7a1 1 0 0 1 0-1.4Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function ImageIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9ZM3.5 3a.5.5 0 0 0-.5.5v7.9l3-3 2.4 2.4 2.6-2.6L13 11V3.5a.5.5 0 0 0-.5-.5h-9Zm6.8 3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function ClockIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.6a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8Zm.75 1.75v3.1l2.2 1.32-.8 1.33L7.25 9V4.85h1.5Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function TrashIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M6.5 1.5h3a1 1 0 0 1 1 1v.5H13a1 1 0 1 1 0 2h-.6l-.7 8.1a1.5 1.5 0 0 1-1.5 1.4H5.8a1.5 1.5 0 0 1-1.5-1.4L3.6 5H3a1 1 0 0 1 0-2h2.5v-.5a1 1 0 0 1 1-1Zm3.5 1.5v-.4a.1.1 0 0 0-.1-.1h-2.8a.1.1 0 0 0-.1.1V3h3ZM5.1 5l.7 7.9a.2.2 0 0 0 .2.1h4.2a.2.2 0 0 0 .2-.1l.7-7.9H5.1Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

/* ── 导航 ──────────────────────────────────────────────────────────────── */

/** 笔记：叠放的纸页 */
export function NoteIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M4 1.4h5.2L13 5.2v9.4H4a1 1 0 0 1-1-1V2.4a1 1 0 0 1 1-1Zm.6 1.4v10.4h7V5.8h-2.3V2.8H4.6Zm6 1.6L9.3 2.9v1.5h1.3Z"
        fill="currentColor"
      />
      <path d="M5.2 8h5.6v1.2H5.2V8Zm0 2.4h3.6v1.2H5.2v-1.2Z" fill="currentColor" />
    </Glyph>
  );
}

/** 图谱：中心节点 + 辐射连线 */
export function GraphIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M8 5.4 4.3 3.6v6.4L8 8.2l3.7 1.8V3.6L8 5.4Zm4.9 3.8-3.7-1.8v3.4l3 1.5a1.6 1.6 0 1 0 .7-3.1ZM3.1 9.2a1.6 1.6 0 1 0 .7 3.1l3-1.5V7.4L3.1 9.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
      />
      <circle cx="8" cy="4.6" r="2.4" fill="currentColor" />
    </Glyph>
  );
}

/** 附件：回形针 */
export function AttachIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M10.9 2.6a3.1 3.1 0 0 1 2.4 5.2l-4.6 4.6a4.4 4.4 0 0 1-6.2-6.2l4.3-4.3 1.1 1.1-4.3 4.3a2.9 2.9 0 0 0 4.1 4.1l4.6-4.6a1.6 1.6 0 0 0-2.3-2.3L6 8.9a.55.55 0 0 0 .8.8l2.9-2.9 1 1-2.9 2.9A1.9 1.9 0 0 1 5.2 8l4.6-4.6c.3-.3.7-.5 1.1-.5Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

/* ── 工具 ──────────────────────────────────────────────────────────────── */

export function MenuIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path d="M2 3h12v1.6H2V3Zm0 4.2h12v1.6H2V7.2Zm0 4.2h12V13H2v-1.6Z" fill="currentColor" />
    </Glyph>
  );
}

export function ArrowLeftIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M7.4 2.9a1 1 0 0 1 .1 1.4L5 7h8a1 1 0 1 1 0 2H5l2.5 2.7a1 1 0 0 1-1.5 1.3l-4-4.4a1 1 0 0 1 0-1.3l4-4.3a1 1 0 0 1 1.4 0Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function PanelIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path d="M2 2.6h12v1.5H2V2.6Zm0 4.7h12v1.5H2V7.3Zm0 4.7h12v1.5H2v-1.5Z" fill="currentColor" />
    </Glyph>
  );
}

export function RefreshIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M8 2a6 6 0 1 0 5.2 3H11a4.5 4.5 0 1 1-1.3-1.7V6h4V2h-1.6v1.1A6 6 0 0 0 8 2Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function PlusIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M8 2a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2H9v4a1 1 0 1 1-2 0V9H3a1 1 0 1 1 0-2h4V3a1 1 0 0 1 1-1Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

/** 铅笔（重命名） */
export function PencilIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M11.6 1.7a1.9 1.9 0 0 1 2.7 2.7l-1.2 1.2-2.7-2.7 1.2-1.2ZM9.7 3.6l2.7 2.7L4.6 14H2v-2.6l7.7-7.8Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function SunIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8ZM8 1a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1Zm0 12a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM15 8a1 1 0 0 1-1 1h-1a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1Zm-10 0a1 1 0 0 1-1 1H3a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1Zm7.9-3.7a1 1 0 0 1-1.4 0l-.7-.7a1 1 0 0 1 1.4-1.4l.7.7a1 1 0 0 1 0 1.4Zm-6.8 6.8a1 1 0 0 1-1.4 0l-.7-.7a1 1 0 0 1 1.4-1.4l.7.7a1 1 0 0 1 0 1.4Zm0-9.4a1 1 0 0 1 0 1.4l-.7.7A1 1 0 0 1 4.1 4.8l.7-.7a1 1 0 0 1 1.4 0Zm6.8 6.8a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.4-1.4l.7-.7a1 1 0 0 1 1.4 0Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function MoonIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.6 5.6 0 0 0-.7 2.6 5.8 5.8 0 0 0 7 6.5 5.7 5.7 0 0 1 1-1.8Z"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function SearchIcon({ className = 'icon icon--sm' }) {
  return (
    <Glyph className={className}>
      <path
        d="M7 1a6 6 0 1 0 3.7 10.7l3.3 3.3 1.4-1.4-3.3-3.3A6 6 0 0 0 7 1Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
        fill="currentColor"
      />
    </Glyph>
  );
}