import { config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';
import { getImageFile, listImageFiles } from './vault.repository.js';

export function listAssets() {
  return listImageFiles(resolveVaultDir(config.vaultDir));
}

export function readAsset(relativePath) {
  return getImageFile(resolveVaultDir(config.vaultDir), relativePath);
}
