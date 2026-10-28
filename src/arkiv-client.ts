/**
 * Styrerommet Arkiv (Jottacloud) Client
 *
 * Provides strictly read-only access to the Styrerommet file archive
 * (arkiv.styrerommet.no), backed by Jottacloud's OpenAPI gRPC-web service.
 *
 * Mutating RPCs (CreateFolder, Allocate, Delete, Move, Copy, Restore) are strictly omitted.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildArchiveWebUrl } from "./urls.ts";
import { getJwtExpiresAt, promptLoginIfNeeded } from "./auth/login.ts";
import { getOrgId } from "./client.ts";

const JOTTA_API_URL = "https://api.jotta.cloud";
const ARKIV_HOST_URL = "https://arkiv.styrerommet.no";

export interface PathItem {
  path: string;
  name: string;
  kind: number;
  type: number; // 1 = FILE, 2 = FOLDER
  downloadLink?: string | undefined;
  size?: number | undefined;
  checksum?: string | undefined;
  createdAtMillis?: number | undefined;
  modifiedAtMillis?: number | undefined;
  deletedAtMillis?: number | undefined;
  mime?: string | undefined;
  childrenList: PathItem[];
  thumbLink?: string | undefined;
  owner?: string | undefined;
}

export interface FormattedArchiveItem {
  name: string;
  path: string;
  type: "folder" | "file";
  webUrl?: string | undefined;
  sizeBytes?: number | undefined;
  sizeHuman?: string | undefined;
  mime?: string | undefined;
  checksum?: string | undefined;
  createdAt?: string | undefined;
  modifiedAt?: string | undefined;
  childrenCount?: number | undefined;
}

export function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || bytes === null) return undefined;
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatPathItem(item: PathItem): FormattedArchiveItem {
  const isFolder = item.type === 2;
  return {
    name: item.name,
    path: item.path,
    type: isFolder ? "folder" : "file",
    webUrl: buildArchiveWebUrl(item.path),
    sizeBytes: isFolder ? undefined : (item.size ?? 0),
    sizeHuman: isFolder ? undefined : formatBytes(item.size ?? 0),
    mime: item.mime,
    checksum: item.checksum,
    createdAt: item.createdAtMillis
      ? new Date(item.createdAtMillis).toISOString()
      : undefined,
    modifiedAt: item.modifiedAtMillis
      ? new Date(item.modifiedAtMillis).toISOString()
      : undefined,
    childrenCount:
      isFolder && item.childrenList ? item.childrenList.length : undefined,
  };
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export function reloadArkivTokens(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/** Get the organization ID configured for this server. */
export function getArkivOrgId(): string {
  return getOrgId();
}

/**
 * Resolve the Bearer token for Jottacloud gRPC-web API.
 * 1. Uses STYREROMMET_ARKIV_TOKEN from environment if set and unexpired.
 * 2. If STYREROMMET_ARKIV_COOKIE is set, attempts /api/refresh on arkiv.styrerommet.no.
 */
export async function getArkivToken(): Promise<string> {
  const envToken = process.env.STYREROMMET_ARKIV_TOKEN;
  if (envToken && !cachedToken) {
    cachedToken = envToken;
    tokenExpiresAt = getJwtExpiresAt(envToken) ?? 0;
  }

  const now = Date.now();
  // If token is valid for at least 60 seconds, use it
  if (cachedToken && (tokenExpiresAt === 0 || tokenExpiresAt - now > 60_000)) {
    return cachedToken;
  }

  // Try refreshing with cookie if available
  const cookie =
    process.env.STYREROMMET_ARKIV_COOKIE || process.env.STYREROMMET_COOKIE;
  if (cookie) {
    try {
      const res = await fetch(`${ARKIV_HOST_URL}/api/refresh`, {
        headers: {
          Accept: "application/json",
          Cookie: cookie,
          "X-ID": `mcp-refresh-${Date.now()}`,
        },
      });
      if (res.ok) {
        const setCookie = res.headers.get("set-cookie") || "";
        const m = setCookie.match(/access_token=([^;]+)/);
        if (m && m[1]) {
          cachedToken = m[1];
          const data = (await res.json().catch(() => ({}))) as any;
          if (data.expiresAt) {
            tokenExpiresAt = data.expiresAt;
          }
          return cachedToken;
        }
      }
    } catch {
      // ignore refresh network errors
    }
  }

  // If token is expired or missing, trigger interactive login
  const isExpired = cachedToken && tokenExpiresAt > 0 && tokenExpiresAt <= now;
  const isMissing = !cachedToken;

  if (isExpired || isMissing) {
    console.error(
      "[auth] Styrerommet Arkiv token missing or expired. Triggering interactive login...",
    );
    const ok = await promptLoginIfNeeded(
      "Styrerommet Arkiv token missing or expired",
    );
    if (ok) {
      const freshToken = process.env.STYREROMMET_ARKIV_TOKEN;
      if (freshToken) {
        cachedToken = freshToken;
        return cachedToken;
      }
    }
  }

  if (cachedToken && !isExpired) {
    return cachedToken;
  }

  throw new Error(
    "Styrerommet Arkiv access token is missing or expired. Run 'styrerommet-mcp --auth' to sign in again.",
  );
}

/**
 * Normalize an archive path.
 * Examples for a configured organization ID:
 *  "" | "/" | "." -> "/resources/{orgId}"
 *  "Documents" | "/Documents" -> "/resources/{orgId}/Documents"
 *  "/resources" -> "/resources"
 *  "/resources/{orgId}-archive" -> "/resources/{orgId}-archive"
 */
export function normalizeArchivePath(inputPath?: string): string {
  const orgId = getArkivOrgId();
  if (
    !inputPath ||
    inputPath.trim() === "" ||
    inputPath === "/" ||
    inputPath === "."
  ) {
    return `/resources/${orgId}`;
  }

  let clean = inputPath.trim();
  if (clean === "/resources" || clean === "resources") {
    return "/resources";
  }

  if (clean.startsWith("/resources/")) {
    return clean;
  }

  if (clean.startsWith("resources/")) {
    return `/${clean}`;
  }

  if (clean.startsWith(`${orgId}-`) || clean.startsWith(`/${orgId}-`)) {
    return `/resources/${clean.replace(/^\//, "")}`;
  }

  if (clean.startsWith(`${orgId}/`) || clean.startsWith(`/${orgId}/`)) {
    return `/resources/${clean.replace(/^\//, "")}`;
  }

  clean = clean.replace(/^\/+/, "");
  return `/resources/${orgId}/${clean}`;
}

// --- Protobuf wire-format encoder / decoder (pure TypeScript) ---

class ProtoReader {
  private pos = 0;
  private buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) break;
      const b = BigInt(byte);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
    }
    return result;
  }

  readString(): string {
    const len = Number(this.readVarint());
    const str = this.buf.toString("utf-8", this.pos, this.pos + len);
    this.pos += len;
    return str;
  }

  readBytes(): Buffer {
    const len = Number(this.readVarint());
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
    } else if (wireType === 1) {
      this.pos += 8;
    } else if (wireType === 2) {
      const len = Number(this.readVarint());
      this.pos += len;
    } else if (wireType === 5) {
      this.pos += 4;
    } else {
      throw new Error(`Unknown wireType ${wireType} at ${this.pos}`);
    }
  }

  readTag(): { fieldNum: number; wireType: number } | null {
    if (!this.hasMore()) return null;
    const tag = Number(this.readVarint());
    return {
      fieldNum: tag >>> 3,
      wireType: tag & 0x07,
    };
  }
}

function decodePathItem(buf: Buffer): PathItem {
  const reader = new ProtoReader(buf);
  const item: PathItem = {
    path: "",
    name: "",
    kind: 0,
    type: 0,
    childrenList: [],
  };

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    switch (tag.fieldNum) {
      case 1:
        item.path = reader.readString();
        break;
      case 2:
        item.name = reader.readString();
        break;
      case 3:
        item.kind = Number(reader.readVarint());
        break;
      case 4:
        item.type = Number(reader.readVarint());
        break;
      case 6:
        item.downloadLink = reader.readString();
        break;
      case 7:
        item.size = Number(reader.readVarint());
        break;
      case 8:
        item.checksum = reader.readString();
        break;
      case 9:
        item.createdAtMillis = Number(reader.readVarint());
        break;
      case 10:
        item.modifiedAtMillis = Number(reader.readVarint());
        break;
      case 11:
        item.deletedAtMillis = Number(reader.readVarint());
        break;
      case 12:
        item.mime = reader.readString();
        break;
      case 13: {
        const childBuf = reader.readBytes();
        item.childrenList.push(decodePathItem(childBuf));
        break;
      }
      case 16:
        item.thumbLink = reader.readString();
        break;
      case 19:
        item.owner = reader.readString();
        break;
      default:
        reader.skip(tag.wireType);
        break;
    }
  }
  return item;
}

function decodeGetPathResponse(buf: Buffer): {
  pathItem?: PathItem | undefined;
  cursor?: string | undefined;
} {
  const reader = new ProtoReader(buf);
  let pathItem: PathItem | undefined;
  let cursor: string | undefined;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    switch (tag.fieldNum) {
      case 1:
        pathItem = decodePathItem(reader.readBytes());
        break;
      case 2:
        cursor = reader.readString();
        break;
      default:
        reader.skip(tag.wireType);
        break;
    }
  }
  return { pathItem, cursor };
}

function decodeGrpcWebFrames(input: string | Buffer): Buffer[] {
  let buf: Buffer;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else {
    // If string has internal '=' padding (common in streamed grpc-web-text), split and decode segments
    if (input.includes("=")) {
      const chunks: Buffer[] = [];
      let start = 0;
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "=") {
          let end = i + 1;
          while (end < input.length && input[end] === "=") end++;
          while ((end - start) % 4 !== 0 && end < input.length) end++;
          const segment = input.slice(start, end);
          chunks.push(Buffer.from(segment, "base64"));
          start = end;
          i = end - 1;
        }
      }
      if (start < input.length) {
        const tail = input.slice(start);
        if (tail.trim()) chunks.push(Buffer.from(tail, "base64"));
      }
      buf =
        chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks);
    } else {
      buf = Buffer.from(input, "base64");
    }
  }

  const frames: Buffer[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flag = buf[pos];
    const len = buf.readUInt32BE(pos + 1);
    pos += 5;
    if (pos + len > buf.length) {
      throw new Error("Truncated Jottacloud gRPC response");
    }
    if (flag === 0x80) {
      const trailers = buf.subarray(pos, pos + len).toString("utf8");
      const status = trailers.match(/(?:^|\r\n)grpc-status:\s*(\d+)/)?.[1];
      if (status && status !== "0") {
        if (status === "16") {
          reloadArkivTokens();
          throw new Error(
            "Jottacloud authentication expired or was rejected. Run 'styrerommet-mcp --auth' to sign in again.",
          );
        }
        throw new Error(`Jottacloud request failed with gRPC status ${status}`);
      }
    }
    if (flag === 0x00) {
      // Data frame
      frames.push(buf.subarray(pos, pos + len));
    }
    pos += len;
  }
  return frames;
}

const SORT_ENUM_MAP: Record<string, number> = {
  NAME_ASC: 1,
  NAME_DESC: 2,
  DATE_ASC: 3,
  DATE_DESC: 4,
  SIZE_ASC: 5,
  SIZE_DESC: 6,
};

function encodeGetPathRequest(
  path: string,
  options: {
    sort?:
      | "NAME_ASC"
      | "NAME_DESC"
      | "DATE_ASC"
      | "DATE_DESC"
      | "SIZE_ASC"
      | "SIZE_DESC";
    limit?: number;
    includeChildren?: boolean;
    includeDeleted?: boolean;
    cursor?: string;
  } = {},
): string {
  const parts: Buffer[] = [];
  const pathBuf = Buffer.from(path, "utf-8");

  // Field 1: string path
  let len = pathBuf.length;
  const lenBytes: number[] = [];
  while (len > 127) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);
  parts.push(Buffer.from([0x0a, ...lenBytes]), pathBuf);

  // Field 2: sort enum
  const sortVal = options.sort ? (SORT_ENUM_MAP[options.sort] ?? 1) : 1;
  parts.push(Buffer.from([0x10, sortVal]));

  // Field 3: limit
  if (options.limit !== undefined) {
    let val = options.limit;
    const bytes: number[] = [];
    while (val > 127) {
      bytes.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    bytes.push(val);
    parts.push(Buffer.from([0x18, ...bytes]));
  }

  // Field 4: includeChildren
  if (options.includeChildren !== undefined) {
    parts.push(Buffer.from([0x20, options.includeChildren ? 1 : 0]));
  }

  // Field 5: includeDeleted
  if (options.includeDeleted !== undefined) {
    parts.push(Buffer.from([0x28, options.includeDeleted ? 1 : 0]));
  }

  // Field 6: cursor
  if (options.cursor) {
    const curBuf = Buffer.from(options.cursor, "utf-8");
    parts.push(Buffer.from([0x32, curBuf.length]), curBuf);
  }

  // Field 7: includeThumb
  parts.push(Buffer.from([0x38, 1]));

  const protoBuf = Buffer.concat(parts);
  const frame = Buffer.alloc(5 + protoBuf.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(protoBuf.length, 1);
  protoBuf.copy(frame, 5);

  return frame.toString("base64");
}

function encodeSearchRequest(
  query: string,
  paths: string[] = [],
  pageIndex = 0,
  pageSize = 50,
): string {
  const parts: Buffer[] = [];

  // Field 1: query
  const qBuf = Buffer.from(query, "utf-8");
  parts.push(Buffer.from([0x0a, qBuf.length]), qBuf);

  // Field 2: path (repeated)
  for (const p of paths) {
    const pBuf = Buffer.from(p, "utf-8");
    parts.push(Buffer.from([0x12, pBuf.length]), pBuf);
  }

  // Field 3: pageIndex
  if (pageIndex > 0) {
    parts.push(Buffer.from([0x18, pageIndex]));
  }

  // Field 4: pageSize
  if (pageSize > 0) {
    parts.push(Buffer.from([0x20, pageSize]));
  }

  const protoBuf = Buffer.concat(parts);
  const frame = Buffer.alloc(5 + protoBuf.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(protoBuf.length, 1);
  protoBuf.copy(frame, 5);

  return frame.toString("base64");
}

// --- High-level Read-Only API Functions ---

/**
 * Retrieve metadata and contents for a specific folder or file in the archive.
 */
export async function getArchivePath(
  targetPath: string,
  options: {
    sort?:
      | "NAME_ASC"
      | "NAME_DESC"
      | "DATE_ASC"
      | "DATE_DESC"
      | "SIZE_ASC"
      | "SIZE_DESC";
    limit?: number;
    includeChildren?: boolean;
    includeDeleted?: boolean;
  } = {},
): Promise<PathItem> {
  const resolvedPath = normalizeArchivePath(targetPath);
  const token = await getArkivToken();
  const body = encodeGetPathRequest(resolvedPath, {
    sort: options.sort ?? "NAME_ASC",
    limit: options.limit ?? 1000,
    includeChildren: options.includeChildren ?? true,
    includeDeleted: options.includeDeleted ?? false,
  });

  const res = await fetch(
    `${JOTTA_API_URL}/no.jotta.openapi.file.v2.FileService/GetPath`,
    {
      method: "POST",
      headers: {
        accept: "application/grpc-web-text",
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web-text",
        "x-grpc-web": "1",
      },
      body,
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Jottacloud GetPath HTTP ${res.status}: ${errText.slice(0, 300)}`,
    );
  }

  const respText = await res.text();
  const frames = decodeGrpcWebFrames(respText);
  if (frames.length === 0) {
    throw new Error(
      `Empty response from Jottacloud GetPath for ${resolvedPath}`,
    );
  }

  const frame = frames[0];
  if (!frame) {
    throw new Error(
      `Empty response from Jottacloud GetPath for ${resolvedPath}`,
    );
  }

  const decoded = decodeGetPathResponse(frame);
  if (!decoded.pathItem) {
    throw new Error(`PathItem not found in response for ${resolvedPath}`);
  }

  return decoded.pathItem;
}

/**
 * Search the file archive by keyword.
 */
export async function searchArchive(
  query: string,
  options: {
    scopePath?: string | undefined;
    pageIndex?: number | undefined;
    pageSize?: number | undefined;
  } = {},
): Promise<FormattedArchiveItem[]> {
  const token = await getArkivToken();
  const scope = options.scopePath
    ? [normalizeArchivePath(options.scopePath)]
    : [normalizeArchivePath("/")];
  const body = encodeSearchRequest(
    query,
    scope,
    options.pageIndex ?? 0,
    options.pageSize ?? 50,
  );

  const res = await fetch(
    `${JOTTA_API_URL}/no.jotta.openapi.search.v2.SearchService/Search`,
    {
      method: "POST",
      headers: {
        accept: "application/grpc-web-text",
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web-text",
        "x-grpc-web": "1",
      },
      body,
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Jottacloud Search HTTP ${res.status}: ${errText.slice(0, 300)}`,
    );
  }

  const respText = await res.text();
  const frames = decodeGrpcWebFrames(respText);
  const results: FormattedArchiveItem[] = [];

  for (const f of frames) {
    const reader = new ProtoReader(f);
    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (tag?.fieldNum === 1) {
        // match: PathItem
        const item = decodePathItem(reader.readBytes());
        results.push(formatPathItem(item));
      } else if (tag) {
        reader.skip(tag.wireType);
      }
    }
  }

  return results;
}

/**
 * Get recent files in the archive.
 */
export async function getRecentArchiveFiles(): Promise<FormattedArchiveItem[]> {
  const token = await getArkivToken();
  // empty request frame: 0x00 00 00 00 00
  const emptyFrame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]).toString(
    "base64",
  );

  const res = await fetch(
    `${JOTTA_API_URL}/no.jotta.openapi.file.v2.FileService/RecentFiles`,
    {
      method: "POST",
      headers: {
        accept: "application/grpc-web-text",
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web-text",
        "x-grpc-web": "1",
      },
      body: emptyFrame,
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Jottacloud RecentFiles HTTP ${res.status}: ${errText.slice(0, 300)}`,
    );
  }

  const respText = await res.text();
  const frames = decodeGrpcWebFrames(respText);
  const results: FormattedArchiveItem[] = [];

  for (const f of frames) {
    const reader = new ProtoReader(f);
    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (tag?.fieldNum === 1) {
        const item = decodePathItem(reader.readBytes());
        results.push(formatPathItem(item));
      } else if (tag) {
        reader.skip(tag.wireType);
      }
    }
  }

  return results;
}

/**
 * Build the authenticated download URL for a file.
 */
export async function getArchiveFileDownloadUrl(
  item: PathItem,
): Promise<string> {
  if (!item.downloadLink) {
    throw new Error(`File at ${item.path} does not have a downloadLink.`);
  }
  const token = await getArkivToken();
  const dlUrl = new URL(item.downloadLink);
  dlUrl.searchParams.set("access_token", token);
  dlUrl.pathname = [dlUrl.pathname, encodeURIComponent(item.name)].join("/");
  return dlUrl.href;
}

/**
 * Download a file from the archive to a local path on disk.
 */
export async function downloadArchiveFile(
  archivePath: string,
  destPath: string,
): Promise<{ bytesDownloaded: number; destPath: string }> {
  const item = await getArchivePath(archivePath, { includeChildren: false });
  if (item.type === 2) {
    throw new Error(
      `Cannot download folder directly: ${item.path}. Use download on individual files.`,
    );
  }

  const downloadUrl = await getArchiveFileDownloadUrl(item);
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(
      `Failed downloading file from ${archivePath}: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);

  return {
    bytesDownloaded: buffer.length,
    destPath,
  };
}

/**
 * Read the text content of a file in the archive directly into memory.
 */
export async function readArchiveFileText(
  archivePath: string,
  maxBytes = 100 * 1024,
): Promise<{ text: string; sizeBytes: number; truncated: boolean }> {
  const item = await getArchivePath(archivePath, { includeChildren: false });
  if (item.type === 2) {
    throw new Error(`Target path is a folder, not a file: ${item.path}`);
  }

  const downloadUrl = await getArchiveFileDownloadUrl(item);
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(
      `Failed reading file from ${archivePath}: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  const text = slice.toString("utf-8");

  return {
    text,
    sizeBytes: buffer.length,
    truncated,
  };
}

export interface ArchiveFileRevision {
  id: string;
  url: string;
  sizeBytes: number;
  sizeHuman?: string | undefined;
  checksum: string;
  createdAt?: string | undefined;
  modifiedAt?: string | undefined;
}

/**
 * List all historical revisions / versions for a specific file in the archive.
 */
export async function listArchiveFileRevisions(
  targetPath: string,
): Promise<ArchiveFileRevision[]> {
  const resolvedPath = normalizeArchivePath(targetPath);
  const token = await getArkivToken();
  const pathBuf = Buffer.from(resolvedPath, "utf-8");

  let len = pathBuf.length;
  const lenBytes: number[] = [];
  while (len > 127) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);
  const req = Buffer.concat([Buffer.from([0x0a, ...lenBytes]), pathBuf]);

  const frame = Buffer.alloc(5 + req.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(req.length, 1);
  req.copy(frame, 5);
  const body = frame.toString("base64");

  const res = await fetch(
    `${JOTTA_API_URL}/no.jotta.openapi.file.v2.FileService/ListRevisions`,
    {
      method: "POST",
      headers: {
        accept: "application/grpc-web-text",
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web-text",
        "x-grpc-web": "1",
      },
      body,
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Jottacloud ListRevisions failed (${res.status}): ${errText.slice(0, 200)}`,
    );
  }

  const text = await res.text();
  const frames = decodeGrpcWebFrames(text);

  const revisions: ArchiveFileRevision[] = [];
  for (const f of frames) {
    const reader = new ProtoReader(f);
    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.fieldNum === 1 && tag.wireType === 2) {
        const revBytes = reader.readBytes();
        const rReader = new ProtoReader(revBytes);
        let id = "",
          url = "",
          size = 0,
          checksum = "",
          createdAt = "",
          modifiedAt = "";
        while (rReader.hasMore()) {
          const rTag = rReader.readTag();
          if (!rTag) break;
          if (rTag.fieldNum === 1) id = rReader.readString();
          else if (rTag.fieldNum === 2) url = rReader.readString();
          else if (rTag.fieldNum === 3) size = Number(rReader.readVarint());
          else if (rTag.fieldNum === 4) checksum = rReader.readString();
          else if (rTag.fieldNum === 5)
            createdAt = new Date(Number(rReader.readVarint())).toISOString();
          else if (rTag.fieldNum === 6)
            modifiedAt = new Date(Number(rReader.readVarint())).toISOString();
          else rReader.skip(rTag.wireType);
        }
        revisions.push({
          id,
          url,
          sizeBytes: size,
          sizeHuman: formatBytes(size),
          checksum,
          createdAt: createdAt || undefined,
          modifiedAt: modifiedAt || undefined,
        });
      } else {
        reader.skip(tag.wireType);
      }
    }
  }

  return revisions;
}

/**
 * Downloads one or more files/folders as a single streaming ZIP archive.
 */
export async function downloadArchiveZip(
  targetPaths: string | string[],
  outputDestPath?: string,
): Promise<{ bytesDownloaded: number; destPath: string }> {
  const pathsArray = Array.isArray(targetPaths) ? targetPaths : [targetPaths];
  const resolvedPaths = pathsArray.map((p) => normalizeArchivePath(p));
  const token = await getArkivToken();

  const parts: Buffer[] = [];
  for (const p of resolvedPaths) {
    const pBuf = Buffer.from(p, "utf-8");
    let len = pBuf.length;
    const lenBytes: number[] = [];
    while (len > 127) {
      lenBytes.push((len & 0x7f) | 0x80);
      len >>>= 7;
    }
    lenBytes.push(len);
    parts.push(Buffer.from([0x0a, ...lenBytes]), pBuf);
  }

  const protoBuf = Buffer.concat(parts);
  const frame = Buffer.alloc(5 + protoBuf.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(protoBuf.length, 1);
  protoBuf.copy(frame, 5);
  const body = frame.toString("base64");

  const res = await fetch(
    `${JOTTA_API_URL}/no.jotta.openapi.file.v2.FileService/DownloadZip`,
    {
      method: "POST",
      headers: {
        accept: "application/grpc-web-text",
        authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web-text",
        "x-grpc-web": "1",
      },
      body,
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Jottacloud DownloadZip ticket failed (${res.status}): ${errText.slice(0, 200)}`,
    );
  }

  const text = await res.text();
  const frames = decodeGrpcWebFrames(text);

  let downloadUrl = "";
  let method = "POST";
  let formBody = "";

  for (const f of frames) {
    const reader = new ProtoReader(f);
    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.fieldNum === 1) downloadUrl = reader.readString();
      else if (tag.fieldNum === 2) method = reader.readString();
      else if (tag.fieldNum === 3) formBody = reader.readString();
      else reader.skip(tag.wireType);
    }
  }

  if (!downloadUrl) {
    throw new Error("Failed to extract download URL from DownloadZip response");
  }

  const zipRes = await fetch(downloadUrl, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formBody,
  });

  if (!zipRes.ok) {
    throw new Error(
      `Failed to stream ZIP file: HTTP ${zipRes.status} ${zipRes.statusText}`,
    );
  }

  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  const firstPath = resolvedPaths[0] || "archive";
  const defaultName = firstPath.split("/").filter(Boolean).pop() || "archive";
  const dest = outputDestPath || `./data/arkiv/${defaultName}.zip`;

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, zipBuffer);

  return {
    bytesDownloaded: zipBuffer.length,
    destPath: dest,
  };
}
