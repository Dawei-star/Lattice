import {
  Activity,
  FilePlus2,
  FolderOpen,
  Inbox,
  Layers3,
  LayoutDashboard,
  Network,
  PanelLeft,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  SquarePlus,
  SunMoon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 主视图标识（Ribbon / TopBar 共用）。 */
export type AppView = 'notes' | 'graph' | 'canvas' | 'review';

export interface RibbonProps {
  view: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSwitcher?: () => void;
  /** 打开专家中心；(tab) 预留目标页签 */
  onOpenExpertsCenter?: (tab?: string) => void;
  onToggleAi?: () => void;
  onCreateNote?: () => void;
  onCaptureInbox?: () => void;
  onCreateCanvas?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onTogglePanel?: () => void;
  onToggleTheme?: () => void;
  onOpenSettings?: () => void;
  theme: string;
}

interface RibbonIconProps {
  icon: LucideIcon;
  size?: number;
  className?: string;
}

function RibbonIcon({ icon: Icon, size = 18, className }: RibbonIconProps) {
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}

export default function Ribbon({ view, onViewChange, onOpenSwitcher, onOpenExpertsCenter, onToggleAi, onCreateNote, onCaptureInbox, onCreateCanvas, onRefresh, refreshing, onTogglePanel, onToggleTheme, onOpenSettings, theme }: RibbonProps) {
  return (
    <nav className="ribbon" aria-label="主导航">
      <div className="ribbon__brand" aria-label="Lattice" title="Lattice">
        <RibbonIcon icon={Layers3} size={21} />
      </div>

      <div className="ribbon__group ribbon__group--primary">
        <button type="button" className="ribbon__button" onClick={() => onCreateNote?.()} aria-label="新建笔记" title="新建笔记">
          <RibbonIcon icon={FilePlus2} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onCaptureInbox?.()} aria-label="收集到 Inbox" title="收集到 Inbox（Ctrl / Cmd + Shift + I）">
          <RibbonIcon icon={Inbox} />
        </button>
        <button type="button" className={`ribbon__button ${view === 'notes' ? 'is-active' : ''}`} onClick={() => onViewChange('notes')} aria-label="笔记" title="笔记">
          <RibbonIcon icon={FolderOpen} />
        </button>
        <button type="button" className={`ribbon__button ${view === 'graph' ? 'is-active' : ''}`} onClick={() => onViewChange('graph')} aria-label="图谱" title="图谱">
          <RibbonIcon icon={Network} />
        </button>
        <button type="button" className={`ribbon__button ${view === 'canvas' ? 'is-active' : ''}`} onClick={() => onViewChange('canvas')} aria-label="画布" title="画布">
          <RibbonIcon icon={LayoutDashboard} />
        </button>
        <button type="button" className={`ribbon__button ${view === 'review' ? 'is-active' : ''}`} onClick={() => onViewChange('review')} aria-label="知识健康" title="知识健康 / Review">
          <RibbonIcon icon={Activity} />
        </button>
      </div>

      <div className="ribbon__group ribbon__group--secondary">
        <button type="button" className="ribbon__button" onClick={() => onCreateCanvas?.()} aria-label="新建白板" title="新建白板">
          <RibbonIcon icon={SquarePlus} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onOpenSwitcher?.()} aria-label="快速切换" title="快速切换（Ctrl / Cmd + K）">
          <RibbonIcon icon={Search} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onToggleAi?.()} aria-label="AI 文件助手" title="AI 文件助手">
          <RibbonIcon icon={Sparkles} />
        </button>
      </div>

      <div className="ribbon__spacer" />

      <div className="ribbon__group ribbon__group--utility">
        <button type="button" className="ribbon__button" onClick={() => onRefresh?.()} disabled={refreshing} aria-label="重新加载" title="重新加载">
          <RibbonIcon icon={RefreshCw} className={refreshing ? 'is-spinning' : undefined} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onTogglePanel?.()} aria-label="切换侧栏" title="切换侧栏">
          <RibbonIcon icon={PanelLeft} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onToggleTheme?.()} aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'} title={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}>
          <RibbonIcon icon={SunMoon} />
        </button>
        <button type="button" className="ribbon__button" onClick={() => onOpenSettings?.()} aria-label="设置" title="设置（Ctrl / Cmd + ,）">
          <RibbonIcon icon={Settings} />
        </button>
      </div>
    </nav>
  );
}
