import { useEffect, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { vaultFiles } from '../api/vault-files.ts';

export interface VaultImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  path: string;
}

/** Vault 图片的统一加载器：桌面端不拼接本地 HTTP URL，改走受限 IPC Blob。 */
export default function VaultImage({ path, onError, ...props }: VaultImageProps) {
  const [src, setSrc] = useState<string | null>(() => (isTauri() ? null : vaultFiles.assetUrl(path)));

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(isTauri() ? null : vaultFiles.assetUrl(path));

    if (isTauri()) {
      vaultFiles.readBlob(path)
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
        })
        .catch(() => {
          if (active) setSrc(null);
        });
    }

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return <img {...props} src={src ?? undefined} onError={onError} />;
}
