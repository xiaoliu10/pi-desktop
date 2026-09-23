declare module 'pdf-parse/lib/pdf-parse.js' { const parse: (buffer: Uint8Array, options?: {version: string}) => Promise<{text: string}>; export default parse; }
