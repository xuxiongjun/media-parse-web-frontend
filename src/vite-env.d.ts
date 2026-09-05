/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** 精简版 File System Access 类型（Chrome / Edge） */
interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string | WriteParams): Promise<void>
  seek(position: number): Promise<void>
  truncate(size: number): Promise<void>
  abort(): Promise<void>
}

interface WriteParams {
  type: 'write' | 'seek' | 'truncate'
  data?: BufferSource | Blob | string
  position?: number
  size?: number
}

interface FileSystemFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle {
  kind: 'directory'
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  requestPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}
