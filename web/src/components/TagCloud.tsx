import type { Tag } from '../api/resources.ts';
import type { VaultFilter } from '../hooks/useVault.ts';

/** 标签云属性。 */
export interface TagCloudProps {
  tags?: Tag[] | null;
  filter: VaultFilter;
  onSelectTag: (tagId: string) => void;
}

/** 标签云：按引用数降序排列，字号随引用数轻微放大 */
export default function TagCloud({ tags, filter, onSelectTag }: TagCloudProps) {
  if (!tags?.length) {
    return <p className="empty-hint">正文里写 #标签 就会自动出现在这里。</p>;
  }

  const maxCount = Math.max(...tags.map((tag) => tag.noteCount), 1);

  return (
    <div className="tagcloud">
      {tags.map((tag) => {
        const active = filter.kind === 'tag' && filter.tagId === tag.id;
        const scale = 0.92 + (tag.noteCount / maxCount) * 0.24;

        return (
          <button
            key={tag.id}
            type="button"
            className={`tag ${active ? 'is-active' : ''}`}
            style={{ fontSize: `${scale}rem` }}
            onClick={() => onSelectTag(tag.id)}
            title={`${tag.noteCount} 篇笔记`}
          >
            <span className="tag__hash">#</span>
            {tag.name}
            <span className="tag__count">{tag.noteCount}</span>
          </button>
        );
      })}
    </div>
  );
}
