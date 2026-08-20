/**
 * Attachment plumbing shared by every composer (in-session and home-screen
 * launch): kind detection, and persisting pasted/dropped blobs through the
 * engine so the worker can read them from disk.
 */

import { engine } from "../engine-client";

export interface Attachment {
  kind: "image" | "file";
  name: string;
  path: string;
}

const IMAGE_EXT_RX = /\.(png|jpe?g|gif|webp)$/i;

export function attachmentKind(name: string): "image" | "file" {
  return IMAGE_EXT_RX.test(name) ? "image" : "file";
}

/** Persist a pasted/dropped blob through the engine; returns an attachment. */
export async function storeBlob(file: File): Promise<Attachment> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const name = file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "attachment");
  const res = await engine.request("attachments.store", { name, base64: btoa(bin) });
  return {
    kind: file.type.startsWith("image/") ? "image" : attachmentKind(name),
    name,
    path: res.path,
  };
}
