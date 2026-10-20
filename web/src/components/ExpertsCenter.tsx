import { Check, Layers3, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import type { Expert, Skill } from '../api/experts.ts';
import type { FileConfirmationResult, FileOperationInput } from '../hooks/useFileConfirmation.tsx';

interface ExpertsCenterProps {
  open: boolean;
  initialTab?: string;
  onClose: () => void;
  onOpenConnections?: () => void;
  experts: Expert[];
  skills: Skill[];
  activeExpertId: string;
  onSelectExpert: (expertId: string) => void;
  onChanged?: () => void | Promise<unknown>;
  onConfirmFileOperation?: (operation: FileOperationInput) => Promise<FileConfirmationResult>;
  vaultDir?: string;
}

/** Compatibility surface for the expert center while the old management screen is being migrated. */
export default function ExpertsCenter({ open, onClose, experts, skills, activeExpertId, onSelectExpert }: ExpertsCenterProps) {
  return (
    <Modal open={open} onClose={onClose} title="专家与 Skill" ariaLabel="专家与 Skill">
      <section className="experts-center-compat">
        <header className="experts-center-compat__header">
          <div>
            <span className="ai-assistant__eyebrow">LATTICE AI</span>
            <h2>选择工作方式</h2>
            <p>专家决定 AI 如何理解当前知识库并处理请求。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭专家面板" title="关闭"><X size={16} /></button>
        </header>
        <div className="experts-center-compat__list">
          {experts.map((expert) => (
            <button type="button" key={expert.id} className={expert.id === activeExpertId ? 'is-active' : ''} onClick={() => { onSelectExpert(expert.id); onClose(); }}>
              <span className="experts-center-compat__icon"><Check size={14} aria-hidden="true" /></span>
              <span><strong>{expert.name}</strong><small>{String(expert.description ?? '按当前知识库上下文回答问题')}</small></span>
            </button>
          ))}
        </div>
        <footer><Layers3 size={14} aria-hidden="true" />已安装 {skills.length} 个 Skill</footer>
      </section>
    </Modal>
  );
}
