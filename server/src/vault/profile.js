import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config/index.js';
import { ValidationError } from '../lib/errors.js';
import { normalizeVaultRelativePath, sanitizeFilePart } from './path.js';

const PROFILE_DIRECTORY = '.lattice';
const PROFILE_FILE_NAME = 'profile.json';

export const DEFAULT_VAULT_PROFILE = Object.freeze({
  version: 1,
  paths: Object.freeze({
    inbox: 'Inbox',
    daily: 'Daily',
    journal: 'Journal',
  }),
});

function normalizeProfilePath(value) {
  let normalized;
  try {
    normalized = normalizeVaultRelativePath(value, '');
  } catch {
    throw new Error('must be a safe Vault-relative folder path');
  }

  const parts = normalized.split('/');
  if (parts.some((part) => part.startsWith('.') || part === '_templates')) {
    throw new Error('must not point to an internal Vault directory');
  }
  if (parts.some((part) => sanitizeFilePart(part, '') !== part)) {
    throw new Error('must use portable folder names');
  }
  return normalized;
}

const profilePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .superRefine((value, context) => {
    try {
      normalizeProfilePath(value);
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
    }
  })
  .transform(normalizeProfilePath);

const profileSchema = z
  .object({
    version: z.literal(1).default(1),
    paths: z
      .object({
        inbox: profilePathSchema.default(DEFAULT_VAULT_PROFILE.paths.inbox),
        daily: profilePathSchema.default(DEFAULT_VAULT_PROFILE.paths.daily),
        journal: profilePathSchema.default(DEFAULT_VAULT_PROFILE.paths.journal),
      })
      .strict()
      .default({}),
  })
  .strict();

export function vaultProfileFilePath(vaultDir = config.vaultDir) {
  return path.join(path.resolve(vaultDir), PROFILE_DIRECTORY, PROFILE_FILE_NAME);
}

export function loadVaultProfile(vaultDir = config.vaultDir) {
  const filePath = vaultProfileFilePath(vaultDir);
  let raw;

  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { profile: DEFAULT_VAULT_PROFILE, filePath, status: 'default', warning: null };
    }
    return invalidProfile(filePath, `Unable to read profile: ${error.message}`);
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return invalidProfile(filePath, `Invalid JSON: ${error.message}`);
  }

  const parsed = profileSchema.safeParse(document);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return invalidProfile(filePath, `Invalid profile: ${reason}`);
  }

  return {
    profile: Object.freeze({
      version: parsed.data.version,
      paths: Object.freeze({ ...parsed.data.paths }),
    }),
    filePath,
    status: 'loaded',
    warning: null,
  };
}

export function getVaultProfile(vaultDir = config.vaultDir) {
  return loadVaultProfile(vaultDir).profile;
}

export function saveVaultProfile(vaultDir = config.vaultDir, document) {
  const parsed = profileSchema.safeParse(document);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'profile',
      message: issue.message,
    }));
    throw new ValidationError('Vault profile 格式无效', details);
  }

  const filePath = vaultProfileFilePath(vaultDir);
  const normalized = {
    version: parsed.data.version,
    paths: parsed.data.paths,
  };
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || !fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return loadVaultProfile(vaultDir);
}

function invalidProfile(filePath, warning) {
  return {
    profile: DEFAULT_VAULT_PROFILE,
    filePath,
    status: 'invalid',
    warning,
  };
}
