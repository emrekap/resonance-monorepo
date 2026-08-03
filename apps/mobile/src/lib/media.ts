import * as DocumentPicker from 'expo-document-picker';
import { File, UploadTask, UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { api } from './api';
import { supabase, supabaseKey, supabaseUrl } from './supabase';

/** What the uploader handles. Mirrors `POST /media`'s `kind` param. */
export type UploadKind = 'video' | 'image' | 'audio';

export interface PickedMedia {
  uri: string;
  kind: UploadKind;
  mimeType: string;
  byteSize?: number;
  fileName?: string;
}

export interface RegisteredMedia {
  mediaAssetId: string;
  bucket: string;
  path: string;
}

/** Pickers don't always report a MIME type; Storage requires one to allowlist. */
const FALLBACK_MIME: Record<UploadKind, string> = {
  video: 'video/mp4',
  image: 'image/jpeg',
  audio: 'audio/mpeg',
};

/**
 * Open the right native picker for the media kind. Video and images come from
 * the photo library; audio has no library picker, so it goes through the
 * document picker filtered to `audio/*` (copied to cache so the file:// URI
 * stays readable for the upload).
 *
 * Resolves null when the user backs out — not an error.
 */
export async function pickMedia(kind: UploadKind): Promise<PickedMedia | null> {
  if (kind === 'audio') {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    return {
      uri: asset.uri,
      kind,
      mimeType: asset.mimeType ?? FALLBACK_MIME.audio,
      byteSize: asset.size,
      fileName: asset.name,
    };
  }

  // The picker would prompt on its own, but asking explicitly lets us fail
  // with a message that names the fix instead of a silent empty picker.
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Allow photo library access in Settings to pick media.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: kind === 'video' ? ['videos'] : ['images'],
    quality: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind,
    mimeType: asset.mimeType ?? FALLBACK_MIME[kind],
    byteSize: asset.fileSize ?? undefined,
    fileName: asset.fileName ?? undefined,
  };
}

/**
 * Step one of the upload handshake: `POST /media` writes the `media_assets`
 * row (PENDING) and answers with the Storage location the bytes belong at.
 */
export async function registerMedia(
  media: PickedMedia,
  workspaceId?: string,
): Promise<RegisteredMedia> {
  const res = await api.media.$post({
    json: {
      kind: media.kind,
      mimeType: media.mimeType,
      byteSize: media.byteSize,
      workspaceId,
    },
  });
  if (res.status !== 201) {
    throw new Error(
      res.status === 404 ? 'Workspace not found.' : 'Could not register the upload with the API.',
    );
  }
  return res.json();
}

/**
 * Step two: stream the file from disk to Supabase Storage.
 *
 * `UploadTask` (not `fetch` + ArrayBuffer) on purpose — a creator video can be
 * hundreds of MB, and this reads from disk natively instead of holding the
 * whole file in JS memory, with progress and cancellation for free. The
 * request authenticates as the *user* (their Supabase JWT), so the bucket's
 * RLS policy — first path segment must be a workspace they belong to — is what
 * authorizes the write. The API never sees the bytes.
 */
export async function uploadToStorage(
  media: PickedMedia,
  registered: RegisteredMedia,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('You are signed out — sign in again to upload.');

  const task = new UploadTask(
    new File(media.uri),
    `${supabaseUrl}/storage/v1/object/${registered.bucket}/${registered.path}`,
    {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      mimeType: media.mimeType,
      headers: {
        authorization: `Bearer ${token}`,
        apikey: supabaseKey,
        'content-type': media.mimeType,
        'x-upsert': 'false',
      },
      onProgress: ({ bytesSent, totalBytes }) => {
        if (totalBytes > 0) options.onProgress?.(bytesSent / totalBytes);
      },
      signal: options.signal,
    },
  );

  const result = await task.uploadAsync();
  if (result.status !== 200) {
    // 403 = the Storage RLS policy said no; 413/415 = bucket size/MIME limits.
    throw new Error(`Storage refused the upload (HTTP ${result.status}).`);
  }
}
