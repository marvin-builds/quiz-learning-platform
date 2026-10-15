import { supabase } from '@/lib/supabase';

// Images of questions and answers live in a public bucket, so their URL needs
// no session and no signing. Admins upload, replace and remove them (#83);
// the database and the bucket's Storage policies accept only object names
// newImageName() gives.
const BUCKET = 'quiz-images';

/** The types the bucket accepts, with the extension an object of each gets. */
export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

/** The bucket's size limit: 5 MiB. */
export const MAX_IMAGE_BYTES = 5242880;

const TYPE_OF_EXTENSION: Record<string, ImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function quizImageUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export const isImageType = (type: string): type is ImageType =>
  Object.prototype.hasOwnProperty.call(IMAGE_TYPES, type);

/** The image type a file name's or URI's extension names, case-insensitive, if any. */
export function imageTypeOfName(name: string | null | undefined): ImageType | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase();
  return extension ? TYPE_OF_EXTENSION[extension] : undefined;
}

// crypto.randomUUID() where the platform has it; elsewhere a version 4 UUID
// from Math.random(), enough for a name that only has to be new.
function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random % 4) + 8).toString(16);
  });
}

/**
 * The object name for a new image of the given type: a random lowercase UUID
 * with the type's extension, at the bucket root, never the original file name.
 */
export function newImageName(mimeType: string): string {
  const extension = isImageType(mimeType) ? IMAGE_TYPES[mimeType] : 'png';
  return `${randomUuid().toLowerCase()}.${extension}`;
}

/** An upload Storage refused or that couldn't be read; its message stays out of the UI. */
export class ImageUploadError extends Error {}

/** Uploads a local file (its URI) under `path`, never overwriting an object. */
export async function uploadImage(path: string, file: { uri: string; mimeType: string }) {
  try {
    const body = await (await fetch(file.uri)).arrayBuffer();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, body, { contentType: file.mimeType, upsert: false });
    if (error) throw error;
  } catch (cause) {
    throw new ImageUploadError('image upload failed', { cause });
  }
}

/**
 * Removes objects and says whether all of them are gone. A removal fails when
 * the request rejects, when it returns an error, or when its result doesn't
 * list every object it was asked to remove: Storage deletes nothing it may
 * not see and says so only by leaving the object out. An object that stays
 * is still publicly reachable until the scheduled cleanup
 * (scripts/clean-up-images.mjs) removes it after its grace period, so the
 * caller tells the admin.
 */
export async function removeImages(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error || !data) return false;
    const removed = new Set(data.map((object) => object.name));
    return paths.every((path) => removed.has(path));
  } catch {
    return false;
  }
}
