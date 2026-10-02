import { useEffect, useRef, useState } from 'react';
import { Inbox, Send } from 'lucide-react';
import Modal from '../ui/Modal.jsx';

/** 快速收集入口：先把碎片放进 Inbox，再在项目上下文中整理。 */
export default function InboxCaptureModal({ open, onClose, onSubmit, busy = false }) {
  const titleRef = useRef(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setContent('');
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextContent = content.trim();
    if (!nextTitle && !nextContent) return;
    const completed = await onSubmit?.({ title: nextTitle, content: nextContent });
    if (completed) {
      setTitle('');
      setContent('');
    }
  };

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title="收集到 Inbox" ariaLabel="收集到 Inbox" className="capture-modal" initialFocusRef={titleRef}>
      <form className="capture-dialog" onSubmit={submit}>
        <header className="capture-dialog__header">
          <div className="capture-dialog__icon" aria-hidden="true"><Inbox size={22} strokeWidth={1.8} /></div>
          <div>
            <span className="capture-dialog__eyebrow">INBOX / QUICK CAPTURE</span>
            <h2>收集一个开发想法</h2>
            <p>先保存到 Inbox，之后再归入项目或交给 AI 整理。</p>
          </div>
          <button type="button" className="icon-btn capture-dialog__close" onClick={onClose} disabled={busy} aria-label="关闭收集窗口">×</button>
        </header>
        <div className="capture-dialog__body">
          <label htmlFor="capture-title">标题 <span>可选</span></label>
          <input
            ref={titleRef}
            id="capture-title"
            value={title}
            maxLength={200}
            autoComplete="off"
            placeholder="例如：考虑把同步状态放进状态栏"
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy}
          />
          <label htmlFor="capture-content">内容</label>
          <textarea
            id="capture-content"
            value={content}
            rows={8}
            maxLength={2_000_000}
            placeholder="记录想法、代码片段、链接或下一步…"
            onChange={(event) => setContent(event.target.value)}
            disabled={busy}
          />
        </div>
        <footer className="capture-dialog__actions">
          <span className="capture-dialog__shortcut">Ctrl / Cmd + Shift + I</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={busy || (!title.trim() && !content.trim())}>
            <Send size={15} strokeWidth={1.8} aria-hidden="true" />
            {busy ? '保存中…' : '保存到 Inbox'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
