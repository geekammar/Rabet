// No-op stub for the `server-only` package.
//
// `server-only` exists to make a build fail if a server module is pulled into
// a client bundle. Vitest does not have that bundler boundary, and the whole
// point of these tests is to exercise the server modules directly, so the
// import is neutralised here.
export {};
