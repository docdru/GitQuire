import { posix } from 'node:path';
import type {
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';

type DirentEntry = NonNullable<
  Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>
>[number];
type ReadFileOptions = Parameters<IFileSystem['readFile']>[1];
type WriteFileOptions = Parameters<IFileSystem['writeFile']>[2];

function notFound(op: string, path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${op} '${path}'`) as Error & {
    code: string;
  };
  error.code = 'ENOENT';
  return error;
}

function normalize(path: string): string {
  const normal = posix.normalize(path.replace(/\\/g, '/'));
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

export class HiddenPathsFs implements IFileSystem {
  private readonly hidden: readonly string[];
  private readonly inner: IFileSystem;

  constructor(inner: IFileSystem, hidden: readonly string[]) {
    this.inner = inner;
    this.hidden = hidden.map((path) => normalize(path).toLowerCase());
  }

  isHidden(path: string): boolean {
    const normal = normalize(path).toLowerCase();
    return this.hidden.some((root) => normal === root || normal.startsWith(`${root}/`));
  }

  private guard(op: string, path: string): void {
    if (this.isHidden(path)) throw notFound(op, path);
  }

  private visible(dir: string, name: string): boolean {
    return !this.isHidden(posix.join(normalize(dir), name));
  }

  readFile(path: string, options?: ReadFileOptions): Promise<string> {
    this.guard('open', path);
    return this.inner.readFile(path, options);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    this.guard('open', path);
    return this.inner.readFileBuffer(path);
  }

  writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    this.guard('open', path);
    return this.inner.writeFile(path, content, options);
  }

  appendFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    this.guard('open', path);
    return this.inner.appendFile(path, content, options);
  }

  async exists(path: string): Promise<boolean> {
    if (this.isHidden(path)) return false;
    return this.inner.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    this.guard('stat', path);
    return this.inner.stat(path);
  }

  lstat(path: string): Promise<FsStat> {
    this.guard('lstat', path);
    return this.inner.lstat(path);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.guard('mkdir', path);
    return this.inner.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    this.guard('scandir', path);
    const names = await this.inner.readdir(path);
    return names.filter((name) => this.visible(path, name));
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    this.guard('scandir', path);
    const read = this.inner.readdirWithFileTypes?.bind(this.inner);
    if (read === undefined) {
      const names = await this.readdir(path);
      return Promise.all(
        names.map(async (name) => {
          const stat = await this.inner.lstat(posix.join(normalize(path), name));
          return {
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: stat.isSymbolicLink,
          } as DirentEntry;
        }),
      );
    }
    const entries = await read(path);
    return entries.filter((entry) => this.visible(path, entry.name));
  }

  rm(path: string, options?: RmOptions): Promise<void> {
    this.guard('rm', path);
    return this.inner.rm(path, options);
  }

  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.guard('copyfile', src);
    this.guard('copyfile', dest);
    return this.inner.cp(src, dest, options);
  }

  mv(src: string, dest: string): Promise<void> {
    this.guard('rename', src);
    this.guard('rename', dest);
    return this.inner.mv(src, dest);
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths().filter((path) => !this.isHidden(path));
  }

  chmod(path: string, mode: number): Promise<void> {
    this.guard('chmod', path);
    return this.inner.chmod(path, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    this.guard('symlink', target);
    this.guard('symlink', linkPath);
    return this.inner.symlink(target, linkPath);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.guard('link', existingPath);
    this.guard('link', newPath);
    return this.inner.link(existingPath, newPath);
  }

  readlink(path: string): Promise<string> {
    this.guard('readlink', path);
    return this.inner.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    this.guard('realpath', path);
    const real = await this.inner.realpath(path);
    if (this.isHidden(real)) throw notFound('realpath', path);
    return real;
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.guard('utime', path);
    return this.inner.utimes(path, atime, mtime);
  }
}
