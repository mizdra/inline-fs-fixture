/**
 * @packageDocumentation
 * The utility for writing fixture files inline.
 */

import { constants, cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Directory, MergeDirectory } from './create-iff-impl.js';
import { createIFFImpl } from './create-iff-impl.js';
import type { FlattenDirectory } from './get-paths.js';
import { changeRootDirOfPaths, getPaths, slash } from './get-paths.js';

export type { Directory, DirectoryItem, FileType } from './create-iff-impl.js';
export { IFFFixtureCreationError } from './error.js';

/**
 * The options for {@link defineIFFCreator}.
 * @public
 */
export interface DefineIFFCreatorOptions {
  /**
   * Function to generate the path to the root directory of the fixture.
   * The fixture will be written to the directory returned by this function.
   *
   * This function is called when a new root directory is needed (when calling {@link CreateIFF}
   * and {@link CreateIFFResult.fork}). However, if {@link CreateIFFOptions.overrideRootDir} is passed,
   * this function is not called and {@link CreateIFFOptions.overrideRootDir} is used for the root directory.
   *
   * @example
   * ```ts
   * import { randomUUID } from 'node:crypto';
   *
   * const fixtureDir = join(tmpdir(), 'your-app-name', process.env['VITEST_POOL_ID']!);
   * const createIFF = defineIFFCreator({ generateRootDir: () => join(fixtureDir, randomUUID()) });
   *
   * const iff = await createIFF({ 'a.txt': 'a', });
   * const forkedIff = await iff.fork({ 'b.txt': 'b' });
   *
   * expect(iff.rootDir).not.toBe(forkedIff.rootDir);
   * ```
   */
  generateRootDir(): string;
  /** Use unix-style path separator (`/`) for paths on windows. */
  unixStylePath?: boolean | undefined;
}

/**
 * The options for {@link CreateIFF}.
 * @public
 */
export interface CreateIFFOptions {
  /**
   * The path to the root directory of the fixture.
   * If this option is passed, the value of this option is used as the root directory
   * instead of the path generated by {@link DefineIFFCreatorOptions.generateRootDir} .
   */
  overrideRootDir?: string | undefined;
}

/**
 * The options for {@link CreateIFFResult.fork}.
 * @public
 */
export interface ForkOptions {
  /** {@inheritDoc CreateIFFOptions.overrideRootDir} */
  overrideRootDir?: string | undefined;
}

/**
 * The return of {@link CreateIFF}.
 * @public
 */
export interface CreateIFFResult<T extends Directory> {
  /**
   * The path of the fixture root directory.
   */
  rootDir: string;
  /**
   * The paths of the fixtures. It is useful to get the path of fixtures in type safety.
   *
   * @example
   * For example, if you create a fixture `a.txt`, then `iff.paths['a.txt'] === join(iff.rootDir, 'a.txt')`.
   *
   * ```ts
   * const createIFF = defineIFFCreator({ generateRootDir: () => fixturesDir });
   * const iff = await createIFF({
   *   'a.txt': 'a',
   *   'b': {
   *      'a.txt': 'b-a',
   *   },
   *   'c/a/a.txt': 'c-a-a',
   * });
   * expect(iff.paths).toStrictEqual({
   *   'a.txt': join(iff.rootDir, 'a.txt'),
   *   'b': join(iff.rootDir, 'b'),
   *   'b/a.txt': join(iff.rootDir, 'b/a.txt'),
   *   'c': join(iff.rootDir, 'c'),
   *   'c/a': join(iff.rootDir, 'c/a'),
   *   'c/a/a.txt': join(iff.rootDir, 'c/a/a.txt'),
   * });
   * ```
   *
   * The `paths` keys are strictly typed. However, index signatures are excluded for convenience.
   *
   * ```ts
   * const iff = await createIFF({
   *   'a.txt': 'a',
   *   'b': {
   *      'a.txt': 'b-a',
   *   },
   *   ['c.txt' as string]: 'c',
   *   ['d' as string]: {
   *     'a.txt': 'd-a',
   *   },
   * });
   * expectType<{
   *   'a.txt': string;
   *   'b': string;
   *   'b/a.txt': string;
   * }>(iff.paths);
   * ```
   */
  paths: FlattenDirectory<T>;
  /**
   * Join `rootDir` and `paths`. It is equivalent to `require('path').join(rootDir, ...paths)`.
   *
   * @example
   * This is useful for generating paths to files not created by `createIFF`.
   *
   * ```ts
   * const createIFF = defineIFFCreator({ generateRootDir: () => fixturesDir });
   * const iff = await createIFF({ 'a.txt': 'a' });
   * expect(iff.join('a.txt')).toBe(join(fixturesDir, 'a.txt'));
   * expect(iff.join('non-existent.txt')).toBe(join(fixturesDir, 'non-existent.txt'));
   * ```
   */
  join(...paths: string[]): string;
  /**
   * Read the file.
   * @param path - The path to the file.
   * @returns The content of the file.
   */
  readFile(path: string): Promise<string>;
  /**
   * Delete the fixture root directory.
   */
  rmRootDir(): Promise<void>;
  /**
   * Delete files under the fixture root directory.
   */
  rmFixtures(): Promise<void>;
  /**
   * Write the fixtures specified in `directory` argument to the fixture root directory.
   */
  writeFixtures(__INTERNAL__overrideRootDir?: string): Promise<void>;
  /**
   * Add fixtures to the fixture root directory.
   * @param additionalDirectory - The definition of fixtures to be added.
   * @returns The {@link CreateIFFResult} with the paths of the added fixtures to {@link CreateIFFResult.paths}.
   */
  addFixtures<const U extends Directory>(additionalDirectory: U): Promise<CreateIFFResult<MergeDirectory<T, U>>>;
  /**
   * Change the root directory and take over the fixture you created.
   *
   * @remarks
   * Internally, first a new root directory is created, and then the fixtures from the old root directory are copied into it.
   * Finally, the fixtures specified in `additionalDirectory` are added to the new root directory.
   *
   * The copy operation will attempt to create a copy-on-write reflink. If the platform does not support copy-on-write,
   * then a fallback copy mechanism is used.
   *
   * @example
   * ```ts
   * const createIFF = defineIFFCreator({ generateRootDir: () => join(fixtureDir, randomUUID()) });
   *
   * const baseIff = await createIFF({
   *   'a.txt': 'a',
   *   'b/a.txt': 'b-a',
   *   },
   * });
   * const forkedIff = await baseIff.fork({
   *   'b/b.txt': 'b-b',
   *   'c.txt': 'c',
   * });
   *
   * // `forkedIff` inherits fixtures from `baseIff`.
   * expect(await readFile(join(forkedIff.rootDir, 'a.txt'), 'utf-8')).toBe('a');
   * expect(await readFile(join(forkedIff.rootDir, 'b/a.txt'), 'utf-8')).toBe('b-a');
   * expect(await readFile(join(forkedIff.rootDir, 'b/b.txt'), 'utf-8')).toBe('b-b');
   * expect(await readFile(join(forkedIff.rootDir, 'c.txt'), 'utf-8')).toBe('c');
   *
   * // The `baseIff` fixtures are left in place.
   * expect(await readFile(join(baseIff.rootDir, 'a.txt'), 'utf-8')).toBe('a');
   * expect(await readFile(join(baseIff.rootDir, 'b/a.txt'), 'utf-8')).toBe('b-a');
   * ```
   * @param additionalDirectory - The definition of fixtures to be added.
   * @param forkOptions -  The fork options.
   */
  fork<const U extends Directory>(
    additionalDirectory: U,
    forkOptions?: ForkOptions,
  ): Promise<CreateIFFResult<MergeDirectory<T, U>>>;
  /**
   * Delete the fixture root directory and write the fixtures specified in `directory` argument again.
   */
  reset(): Promise<void>;
}

/**
 * Create fixtures in the specified directory.
 *
 * @remarks
 * The path must be in POSIX-style (`'dir/file.txt'`).
 * Use of Windows-style path (`'dir\\file.txt'`) is an undefined behavior.
 *
 * @remarks
 * Fixtures in the same directory are created in parallel.
 * The order in which fixtures are created changes from time to time.
 *
 * @example
 * ```ts
 * const iff = await createIFF(
 *   {
 *   'a.txt': 'a',
 *   'b': {
 *     'a.txt': 'b-a',
 *   },
 *   'c/a/a.txt': 'c-a-a',
 * });
 * expect(await readFile(join(iff.rootDir, 'a.txt'), 'utf-8')).toBe('a');
 * expect(await readFile(join(iff.rootDir, 'b/a.txt'), 'utf-8')).toBe('b-a');
 * expect(await readFile(join(iff.rootDir, 'c/a/a.txt'), 'utf-8')).toBe('c-a-a');
 * ```
 * @param directory - The definition of fixtures to be created.
 * @param options - Options for creating fixtures.
 * @returns An object that provides functions to manipulate the fixtures.
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type CreateIFF = <const T extends Directory, U extends Directory = {}>(
  directory: T,
  options?: CreateIFFOptions,
  __INTERNAL__prevIFF?: CreateIFFResult<U>,
) => Promise<CreateIFFResult<MergeDirectory<U, T>>>;

/**
 * Define {@link CreateIFF}.
 * @param defineIFFCreatorOptions - The options for {@link defineIFFCreator}.
 * @public
 */
export function defineIFFCreator(defineIFFCreatorOptions: DefineIFFCreatorOptions): CreateIFF {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  async function createIFF<const T extends Directory, U extends Directory = {}>(
    directory: T,
    options?: CreateIFFOptions,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __INTERNAL__prevIFF?: CreateIFFResult<U>,
  ): Promise<CreateIFFResult<MergeDirectory<U, T>>> {
    const rootDir = options?.overrideRootDir ?? defineIFFCreatorOptions.generateRootDir();
    const unixStylePath = defineIFFCreatorOptions.unixStylePath ?? false;
    const paths = {
      ...changeRootDirOfPaths(__INTERNAL__prevIFF?.paths ?? ({} as FlattenDirectory<U>), rootDir, unixStylePath),
      ...getPaths(directory, rootDir, unixStylePath),
    } as FlattenDirectory<MergeDirectory<U, T>>;

    const iff: CreateIFFResult<MergeDirectory<U, T>> = {
      rootDir: unixStylePath ? slash(rootDir) : rootDir,
      paths,
      join(...paths) {
        return unixStylePath ? slash(join(rootDir, ...paths)) : join(rootDir, ...paths);
      },
      readFile: async (path) => {
        return await readFile(join(rootDir, path), 'utf-8');
      },
      async rmRootDir() {
        await rm(rootDir, { recursive: true, force: true });
      },
      async rmFixtures() {
        const files = await readdir(rootDir);
        await Promise.all(files.map(async (file) => rm(iff.join(file), { recursive: true, force: true })));
      },
      // eslint-disable-next-line @typescript-eslint/naming-convention
      async writeFixtures(__INTERNAL__overrideRootDir?: string) {
        if (__INTERNAL__prevIFF) await __INTERNAL__prevIFF.writeFixtures(__INTERNAL__overrideRootDir ?? rootDir);
        await createIFFImpl(directory, __INTERNAL__overrideRootDir ?? rootDir);
      },
      async addFixtures(additionalDirectory) {
        return createIFF(additionalDirectory, { overrideRootDir: rootDir }, iff);
      },
      async fork(additionalDirectory, forkOptions) {
        const newRootDir = forkOptions?.overrideRootDir ?? defineIFFCreatorOptions.generateRootDir();
        if (newRootDir === rootDir) {
          throw new Error('New `rootDir` must be different from the `rootDir` generated by `generateRootDir`.');
        }

        const forkedIff = await createIFF(additionalDirectory, { ...options, overrideRootDir: newRootDir }, iff);

        await cp(rootDir, newRootDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
        return forkedIff;
      },
      async reset() {
        await iff.rmRootDir();
        await iff.writeFixtures();
      },
    };

    await iff.writeFixtures();

    return iff;
  }

  return createIFF;
}
