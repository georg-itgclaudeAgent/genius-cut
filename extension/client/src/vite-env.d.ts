/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GENIUSCUT_PREVIEW?: string;
  /** "1" only in a personal build (.env.production.local): compiles in the Claude assistant bridge. */
  readonly VITE_GENIUSCUT_CLAUDE?: string;
}
