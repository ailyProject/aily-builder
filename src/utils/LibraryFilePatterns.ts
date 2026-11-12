// Included implementation fragments affect dependency analysis and cache keys,
// but remain outside the independent compilation source extensions.
export const LIBRARY_INCLUDE_FILE_GLOB = '**/*.{h,hpp,c,cpp,ipp,inc}';
export const LIBRARY_FINGERPRINT_FILE_GLOBS = [
  '**/*.{h,hpp,hh,c,cpp,S,s,ipp,inc}',
  'library.properties'
];
